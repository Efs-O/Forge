import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  busPaths,
  clearExchange,
  waitForReply,
  writeQuestion,
  type BusPaths,
} from '../../src/agentBus/agentBus';
import { AgentRoutes } from '../../src/backend/agentRoutes';

const TOKEN = 'f'.repeat(64);
let home: string;
let paths: BusPaths;
let accepted: string[];
let full: boolean;
let routes: AgentRoutes;
let server: http.Server;
let base: string;

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-agent-routes-'));
  paths = busPaths(home);
  accepted = [];
  full = false;
  routes = new AgentRoutes({
    paths: () => paths,
    inbox: {
      accept: (prompt) => {
        if (full) return undefined;
        accepted.push(prompt);
        return accepted.length;
      },
    },
    token: TOKEN,
  });
  server = http.createServer((req, res) => void routes.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  routes.setEnabled(true);
  routes.onListening(base);
});

afterEach(async () => {
  routes.dispose();
  await new Promise((r) => server.close(r));
  await fs.promises.rm(home, { recursive: true, force: true });
});

async function post(
  route: string,
  body: string,
  { token = TOKEN, type = 'text/plain' }: { token?: string | null; type?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': type };
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${route}`, { method: 'POST', headers, body });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('endpoint.json', () => {
  it('is published with the url and token, and removed on dispose', () => {
    const ep = JSON.parse(fs.readFileSync(paths.endpoint, 'utf8'));
    expect(ep).toMatchObject({ url: base, token: TOKEN });
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.endpoint).mode & 0o777).toBe(0o600);
    }
    routes.dispose();
    expect(fs.existsSync(paths.endpoint)).toBe(false);
  });

  it("is never removed when another window's token is in it", () => {
    fs.writeFileSync(paths.endpoint, JSON.stringify({ url: 'x', token: 'other' }));
    routes.dispose();
    expect(fs.existsSync(paths.endpoint)).toBe(true);
  });

  it('follows agent_bus.enabled on refresh', () => {
    routes.setEnabled(false);
    expect(fs.existsSync(paths.endpoint)).toBe(false);
    routes.setEnabled(true);
    expect(fs.existsSync(paths.endpoint)).toBe(true);
  });
});

describe('auth and limits', () => {
  it('answers 401 without a token or with a wrong one, and queues nothing', async () => {
    expect((await post('/agent/message?from=x', 'hi', { token: null })).status).toBe(401);
    expect((await post('/agent/message?from=x', 'hi', { token: 'e'.repeat(64) })).status).toBe(401);
    expect((await post('/agent/message?from=x', 'hi', { token: 'short' })).status).toBe(401);
    expect(accepted).toEqual([]);
  });

  it('answers 404 while disabled, even with the token', async () => {
    routes.setEnabled(false);
    expect((await post('/agent/message?from=x', 'hi')).status).toBe(404);
  });

  it('rejects an oversized text, a bad sender and a bad id with 400', async () => {
    expect((await post('/agent/message?from=x', 'a'.repeat(8001))).status).toBe(400);
    expect((await post('/agent/message?from=x', 'a'.repeat(8000))).status).toBe(202);
    expect((await post('/agent/message?from=%3Cscript%3E', 'hi')).status).toBe(400);
    expect((await post('/agent/message', 'hi')).status).toBe(400);
    expect((await post('/agent/message?from=x', '   ')).status).toBe(400);
    expect((await post('/agent/reply?id=..%2Fx', 'hi')).status).toBe(400);
    expect((await post('/agent/message', '{', { type: 'application/json' })).status).toBe(400);
  });

  it('answers 429 when the inbox is full', async () => {
    full = true;
    expect((await post('/agent/message?from=x', 'hi')).status).toBe(429);
  });
});

describe('routes', () => {
  it('turns a message into a labelled prompt (text or JSON)', async () => {
    const plain = await post('/agent/message?from=forge-dd', 'hello');
    expect(plain).toEqual({ status: 202, body: { queued: 1 } });
    const json = await post('/agent/message', JSON.stringify({ from: 'codex', text: 'yo' }), {
      type: 'application/json',
    });
    expect(json.status).toBe(202);
    expect(accepted[0]).toContain('**forge-dd says:**\n\nhello');
    expect(accepted[1]).toContain('**codex says:**\n\nyo');
  });

  it('delivers a reply to the waiting question, and the exchange leaves only the shipped files', async () => {
    writeQuestion(paths, 'fg1-abc', 's', 'q');
    const waiting = waitForReply(paths, 'fg1-abc', 5_000, undefined, 10);
    const res = await post('/agent/reply?id=fg1-abc', 'the answer');
    expect(res).toEqual({ status: 200, body: { delivered: true } });
    await expect(waiting).resolves.toBe('the answer');
    clearExchange(paths, 'fg1-abc');
    // The ledger's CI row (AGENT_MESSAGING_PLAN.md): a new durable artifact in
    // the bus folder must get a ledger row and cleanup before this passes.
    expect(fs.readdirSync(paths.root).sort()).toEqual([
      'README.md',
      'endpoint.json',
      'forge.sh',
      'inbox',
      'outbox',
    ]);
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
    expect(fs.readdirSync(paths.outbox)).toEqual([]);
  });

  it('refuses other methods and paths', async () => {
    const get = await fetch(`${base}/agent/message`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(405);
    expect((await post('/agent/other', 'x')).status).toBe(404);
  });
});

/** Run the shipped client the way another agent would. Async: the routes
 *  answer from this same process, so a blocking spawn would deadlock. */
function runClient(
  args: string[],
  input: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'bash',
      [paths.script.replace(/\\/g, '/'), ...args],
      { timeout: 20_000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code: typeof code === 'number' ? code : 1, out: stdout + stderr });
      },
    );
    child.stdin?.end(input);
  });
}

describe('forge.sh against the routes', () => {
  // Needs a bash that can read this OS's paths and has curl (Git Bash on
  // Windows, not WSL's). Skipped, not failed, where there is none.
  let usable = false;
  beforeAll(async () => {
    const probe = path.join(os.tmpdir(), `forge-bash-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    usable = await new Promise((resolve) =>
      execFile(
        'bash',
        ['-c', 'test -f "$1" && command -v curl >/dev/null', '_', probe.replace(/\\/g, '/')],
        { timeout: 10_000 },
        (err) => resolve(!err),
      ),
    );
    fs.rmSync(probe, { force: true });
  });

  it('say starts a message and reply answers a question', async (ctx) => {
    if (!usable) ctx.skip();
    const said = await runClient(['say', 'claude-review'], 'hello Forge\n');
    expect(said).toMatchObject({ code: 0 });
    expect(accepted[0]).toContain('**claude-review says:**\n\nhello Forge');

    writeQuestion(paths, 'fg2-abc', 's', 'q');
    const replied = await runClient(['reply', 'fg2-abc'], 'pong\n');
    expect(replied.out).toContain('"delivered":true');
    await expect(waitForReply(paths, 'fg2-abc', 1_000, undefined, 10)).resolves.toBe('pong\n');
  }, 30_000);

  it('a reply still lands through the outbox file when Forge is gone; a message does not', async (ctx) => {
    if (!usable) ctx.skip();
    routes.dispose();
    const replied = await runClient(['reply', 'fg3-abc'], 'offline answer');
    expect(replied).toMatchObject({ code: 0 });
    await expect(waitForReply(paths, 'fg3-abc', 1_000, undefined, 10)).resolves.toBe(
      'offline answer',
    );
    const said = await runClient(['say', 'x'], 'hi');
    expect(said.code).toBe(1);
    expect(said.out).toContain('not reachable');
  }, 30_000);

  it('join sends CLAUDE_PID to /agent/join; send relays with a `to` (§10)', async (ctx) => {
    if (!usable) ctx.skip();
    const joins: [string, number][] = [];
    const relays: [string, string, string][] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: { accept: () => 1 },
      token: TOKEN,
      join: (alias, pid) => (joins.push([alias, pid]), { ok: true, reply: 'joined' }),
      relay: async (from, to, text) => (
        relays.push([from, to, text]),
        { ok: true, exchangeId: 'x1' }
      ),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const noPid = await runClient(['join', 'claude'], '', { CLAUDE_PID: '' });
    expect(noPid.code).toBe(2);
    const joined = await runClient(['join', 'claude'], '', { CLAUDE_PID: '4242' });
    expect(joined.out).toContain('"joined":true');
    expect(joins).toEqual([['claude', 4242]]);
    const sent = await runClient(['send', 'claude', 'codex'], 'plan ready\n');
    expect(sent.out).toContain('"relayed":true');
    expect(relays).toEqual([['claude', 'codex', 'plan ready\n']]);
  }, 30_000);

  it('steer to forge queues at the front and interrupts the running turn (§6)', async (ctx) => {
    if (!usable) ctx.skip();
    const calls: string[] = [];
    routes = new AgentRoutes({
      paths: () => paths,
      inbox: {
        accept: (_prompt, _from, front) => (calls.push(`accept front=${String(front)}`), 1),
      },
      token: TOKEN,
      interruptForge: async () => void calls.push('interrupt'),
    });
    routes.setEnabled(true);
    routes.onListening(base);
    const steered = await runClient(['steer', 'claude', 'forge'], 'use ask_live_session');
    expect(steered.out).toContain('"steered":true');
    expect(calls).toEqual(['accept front=true', 'interrupt']);
    const said = await runClient(['say', 'claude'], 'plain');
    expect(said.out).toContain('"queued"');
    expect(calls.slice(2)).toEqual(['accept front=false']);
  }, 30_000);

  it('refuses a bad id or name before sending anything', async (ctx) => {
    if (!usable) ctx.skip();
    expect((await runClient(['reply', '../x'], 'a')).code).toBe(2);
    expect((await runClient(['say', 'a b'], 'a')).code).toBe(2);
    expect(accepted).toEqual([]);
  }, 30_000);
});

describe('sender validation and relay gating (M6/§4)', () => {
  // Reassign the module-level `routes` (the server closure reads it by name)
  // and re-enable it, since beforeEach enabled the original instance.
  function install(deps: ConstructorParameters<typeof AgentRoutes>[0]): void {
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
  }

  it('rejects an unknown `from` with the live list, before the inbox', async () => {
    install({
      paths: () => paths,
      inbox: { accept: (p) => (accepted.push(p), accepted.length) },
      token: TOKEN,
      validateFrom: (from) =>
        from === 'codex' || from === 'forge'
          ? { ok: true }
          : { ok: false, error: `unknown sender "${from}"; live aliases: codex` },
    });
    const { status, body } = await post('/agent/message?from=mallory', 'hi');
    expect(status).toBe(400);
    expect(body.error).toContain('mallory');
    expect(accepted).toEqual([]);
  });

  it('accepts a known `from` and delivers to the inbox', async () => {
    install({
      paths: () => paths,
      inbox: { accept: (p) => (accepted.push(p), accepted.length) },
      token: TOKEN,
      validateFrom: (from) => (from === 'codex' ? { ok: true } : { ok: false, error: 'no' }),
    });
    const { status } = await post('/agent/message?from=codex', 'hi');
    expect(status).toBe(202);
    expect(accepted).toHaveLength(1);
  });

  it('rejects a non-Forge `to` when no relay is installed (no silent inbox delivery)', async () => {
    install({
      paths: () => paths,
      inbox: { accept: (p) => (accepted.push(p), accepted.length) },
      token: TOKEN,
      validateFrom: () => ({ ok: true }),
      // no relay
    });
    const { status, body } = await post('/agent/message?from=codex&to=claude', 'hi');
    expect(status).toBe(400);
    expect(body.error).toContain('no relay');
    expect(accepted).toEqual([]);
  });
});

describe('typed lifecycle command dispatch (§8, P3)', () => {
  function install(deps: ConstructorParameters<typeof AgentRoutes>[0]): void {
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
  }

  it('dispatches a `to: forge` mesh command, not the inbox', async () => {
    let got: string | undefined;
    install({
      paths: () => paths,
      inbox: { accept: (p) => (accepted.push(p), accepted.length) },
      token: TOKEN,
      validateFrom: () => ({ ok: true }),
      handleCommand: async (text) => {
        got = text;
        return { ok: true, reply: 'codex parked' };
      },
    });
    const { status, body } = await post('/agent/message?from=codex', 'standby codex');
    expect(status).toBe(200);
    expect(body).toEqual({ command: 'standby', reply: 'codex parked' });
    expect(got).toBe('standby codex');
    expect(accepted).toEqual([]); // not queued as a prompt
  });

  it('treats ordinary `to: forge` text as a prompt, not a command', async () => {
    install({
      paths: () => paths,
      inbox: { accept: (p) => (accepted.push(p), accepted.length) },
      token: TOKEN,
      validateFrom: () => ({ ok: true }),
      handleCommand: async () => ({ ok: true, reply: 'should not be called' }),
    });
    const { status } = await post('/agent/message?from=codex', 'please review the plan');
    expect(status).toBe(202);
    expect(accepted).toHaveLength(1);
  });

  it('a command that fails to dispatch is a 400, not a queued prompt', async () => {
    install({
      paths: () => paths,
      inbox: { accept: (p) => (accepted.push(p), accepted.length) },
      token: TOKEN,
      validateFrom: () => ({ ok: true }),
      handleCommand: async () => ({ ok: false, error: 'no session to park' }),
    });
    const { status, body } = await post('/agent/message?from=codex', 'standby ghost');
    expect(status).toBe(400);
    expect(body.error).toContain('no session to park');
    expect(accepted).toEqual([]);
  });
});
