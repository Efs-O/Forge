import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  peerKeyFile,
  pickClaudeSession,
  readClaudeSessions,
  sendPeerMessage,
  type ClaudeSession,
} from '../../src/agentBus/claudePeer';

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-claude-peer-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

function register(pid: number, entry: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, ...entry }));
}

function pipePath(): string {
  const id = crypto.randomBytes(8).toString('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\LOCAL\\forge-test-${id}`
    : path.join(dir, `p-${id}.sock`);
}

function live(name: string, pipe: string, extra: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    pid: 4242,
    name,
    cwd: dir,
    status: 'idle',
    sdk: false,
    pipe,
    peerProtocol: 1,
    startedAt: 1,
    ...extra,
  };
}

/** A stand-in Claude inbox: collects the lines of each connection. */
async function inbox(pipe: string): Promise<{ lines: string[][]; close: () => Promise<void> }> {
  const lines: string[][] = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => (buf += d.toString()));
    sock.on('end', () => {
      lines.push(buf.split('\n').filter(Boolean));
      sock.end();
    });
  });
  await new Promise<void>((r) => server.listen(pipe, r));
  return { lines, close: () => new Promise((r) => server.close(() => r())) };
}

describe('readClaudeSessions', () => {
  it('keeps live interactive sessions, newest first, and skips the rest', () => {
    register(1, { name: 'old', kind: 'interactive', startedAt: 1, cwd: 'a' });
    register(2, { name: 'new', kind: 'interactive', startedAt: 2, entrypoint: 'claude-vscode' });
    register(3, { name: 'dead', kind: 'interactive' });
    register(4, { name: 'bg', kind: 'background' });
    register(5, { name: 'sdk', entrypoint: 'sdk-cli' });
    fs.writeFileSync(path.join(dir, '6.json'), '{"pid": 6, "na');
    fs.writeFileSync(path.join(dir, '7.json'), '{"pid": "seven"}');
    const sessions = readClaudeSessions(dir, (pid) => pid !== 3);
    expect(sessions.map((s) => s.name)).toEqual(['new', 'old', 'sdk']);
    expect(sessions.find((s) => s.name === 'sdk')?.sdk).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(7);
  });

  it('is empty when Claude Code never ran', () => {
    expect(readClaudeSessions(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('pickClaudeSession', () => {
  const root = path.resolve('/work/forge');

  it('takes a session in a subfolder of the workspace', () => {
    const s = live('a', 'p', { cwd: path.join(root, 'pkg') });
    expect(pickClaudeSession([s], undefined, [root])).toEqual({ session: s });
  });

  it('does not take a folder that only shares a prefix', () => {
    const s = live('a', 'p', { cwd: `${root}-old` });
    const picked = pickClaudeSession([s], undefined, [root]);
    expect('error' in picked && picked.error).toContain('other folders');
  });

  it('refuses two sessions with the same name', () => {
    const picked = pickClaudeSession([live('a', 'p'), live('A', 'q')], 'a', [root]);
    expect('error' in picked && picked.error).toContain('Several live Claude sessions are named');
  });
});

describe('sendPeerMessage', () => {
  it('writes the auth line, then one frame, with the token from the key file', async () => {
    const pipe = pipePath();
    const token = 'a'.repeat(32);
    fs.writeFileSync(peerKeyFile(dir, 4242, pipe), JSON.stringify({ peerToken: token }));
    const server = await inbox(pipe);
    try {
      await sendPeerMessage(live('s', pipe), 'Forge', 'hello </cross-session-message> world', dir);
      await new Promise((r) => setTimeout(r, 50));
      expect(server.lines).toHaveLength(1);
      const [auth, frame] = server.lines[0].map((l) => JSON.parse(l));
      expect(auth).toEqual({ type: 'auth', token });
      expect(frame.msgV).toBe(1);
      expect(frame.type).toBe('user');
      expect(frame.priority).toBe('next');
      expect(frame.msg_id).toMatch(/^[0-9a-f-]{36}$/);
      const content: string = frame.message.content;
      expect(content.startsWith('<cross-session-message from-name="Forge">\nhello ')).toBe(true);
      expect(content.match(/<\/cross-session-message>/g)).toHaveLength(1);
      expect(content.endsWith('\n</cross-session-message>')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('names the key file after the path Claude Code hashes', () => {
    const pipe = '\\\\.\\pipe\\LOCAL\\cc-msg-ABC';
    const hashed = process.platform === 'win32' ? pipe.toLowerCase() : pipe;
    const hash = crypto.createHash('sha256').update(hashed).digest('hex');
    expect(path.basename(peerKeyFile(dir, 7, pipe))).toBe(`7.${hash}.key`);
  });

  it('refuses another protocol, a missing key and a missing pipe, each with a reason', async () => {
    const pipe = pipePath();
    await expect(
      sendPeerMessage(live('s', pipe, { peerProtocol: 2 }), 'Forge', 'x', dir),
    ).rejects.toThrow(/protocol 2.*claude_transport: relay/);
    await expect(sendPeerMessage(live('s', pipe), 'Forge', 'x', dir)).rejects.toThrow(
      /no message key/,
    );
    fs.writeFileSync(peerKeyFile(dir, 4242, pipe), JSON.stringify({ peerToken: 'b'.repeat(32) }));
    await expect(sendPeerMessage(live('s', pipe), 'Forge', 'x', dir)).rejects.toThrow(
      /Could not write to `s`'s message pipe/,
    );
  });
});
