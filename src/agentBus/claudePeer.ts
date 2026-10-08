import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

/**
 * Reaching a running Claude Code session through its own peer pipe
 * (docs/plans/AGENT_MESSAGING_PLAN.md). Claude Code (2.1.273) registers every
 * session in `~/.claude/sessions/<pid>.json` and listens on a named pipe; a
 * message written there is shown in that session's chat, mid-turn, with no
 * watcher. Both the registry and the wire format are undocumented, so this file
 * only reads the registry, parses it tolerantly, refuses any protocol but 1,
 * and reports every failure instead of falling back.
 */

export const PEER_PROTOCOL = 1;
const SEND_TIMEOUT_MS = 5_000;
const TAG = 'cross-session-message';

const RegistryEntrySchema = z
  .object({
    pid: z.number().int().positive(),
    sessionId: z.string().optional(),
    name: z.string().optional(),
    cwd: z.string().optional(),
    status: z.string().optional(),
    kind: z.string().optional(),
    entrypoint: z.string().optional(),
    messagingSocketPath: z.string().optional(),
    peerProtocol: z.number().optional(),
    startedAt: z.number().optional(),
  })
  .passthrough();

export interface ClaudeSession {
  pid: number;
  /** The conversation id: stable across a resume, which gets a new pid. */
  sessionId?: string | undefined;
  name: string;
  cwd: string;
  status: string;
  /** Launched by a program (Agent SDK), not a person: never picked by default. */
  sdk: boolean;
  pipe: string | undefined;
  peerProtocol: number | undefined;
  startedAt: number | undefined;
}

export function claudeSessionsDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'sessions');
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live interactive sessions from the registry. A dead pid's file is skipped,
 *  never deleted: the registry belongs to Claude Code. */
export function readClaudeSessions(
  dir: string = claudeSessionsDir(),
  isAlive: (pid: number) => boolean = pidAlive,
): ClaudeSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: ClaudeSession[] = [];
  for (const file of names) {
    if (!/^\d+\.json$/.test(file)) continue;
    let parsed;
    try {
      parsed = RegistryEntrySchema.safeParse(
        JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')),
      );
    } catch {
      continue; // Half-written by Claude Code; the next call sees the whole file.
    }
    if (!parsed.success) continue;
    const e = parsed.data;
    if (e.kind !== undefined && e.kind !== 'interactive') continue;
    if (!isAlive(e.pid)) continue;
    sessions.push({
      pid: e.pid,
      sessionId: e.sessionId,
      name: e.name ?? `pid-${e.pid}`,
      cwd: e.cwd ?? '',
      status: e.status ?? 'unknown',
      sdk: (e.entrypoint ?? '').startsWith('sdk'),
      pipe: e.messagingSocketPath,
      peerProtocol: e.peerProtocol,
      startedAt: e.startedAt,
    });
  }
  return sessions.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** Claude Code names the key file after the SHA-256 of the pipe path, which it
 *  lower-cases on Windows (pipe names are case-insensitive there). */
export function peerKeyFile(dir: string, pid: number, pipe: string): string {
  const canonical = process.platform === 'win32' ? pipe.toLowerCase() : pipe;
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  return path.join(dir, `${pid}.${hash}.key`);
}

function readPeerToken(dir: string, session: ClaudeSession, pipe: string): string {
  const file = peerKeyFile(dir, session.pid, pipe);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(
      `\`${session.name}\` publishes no message key (${(err as NodeJS.ErrnoException).code ?? 'unreadable'}). ` +
        'Its Claude Code may be too old or too new for Forge; set `agent_bus.claude_transport: relay`.',
    );
  }
  const token = (JSON.parse(raw) as { peerToken?: unknown }).peerToken;
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) {
    throw new Error(
      `\`${session.name}\`'s message key has an unexpected shape; set \`agent_bus.claude_transport: relay\`.`,
    );
  }
  return token;
}

/** Keep the body from closing the envelope early. */
function envelope(fromName: string, text: string): string {
  const name = fromName.replace(/["<>]/g, '');
  const body = text.replace(new RegExp(`<(/?)${TAG}`, 'gi'), `<$1${TAG}-quoted`);
  return `<${TAG} from-name="${name}">\n${body}\n</${TAG}>`;
}

/**
 * Write one message into a session's pipe: an auth line, then one JSON line.
 * Resolves once the pipe closes cleanly. The receiver sends no receipt, so a
 * message it holds for approval (a bypass session without
 * `crossSessionInbound: accept`) also resolves; the caller's wait reports it.
 */
export async function sendPeerMessage(
  session: ClaudeSession,
  fromName: string,
  text: string,
  dir: string = claudeSessionsDir(),
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<void> {
  const pipe = session.pipe;
  if (!pipe)
    throw new Error(`\`${session.name}\` has no message pipe (messaging is off in that session).`);
  if (session.peerProtocol !== PEER_PROTOCOL) {
    throw new Error(
      `\`${session.name}\` speaks peer protocol ${session.peerProtocol ?? 'none'}; Forge speaks ${PEER_PROTOCOL}. ` +
        'Set `agent_bus.claude_transport: relay` until Forge is updated.',
    );
  }
  const token = readPeerToken(dir, session, pipe);
  const frame = {
    msgV: 1,
    msg_id: crypto.randomUUID(),
    type: 'user',
    message: { role: 'user', content: envelope(fromName, text) },
    priority: 'next',
  };
  const payload = `${JSON.stringify({ type: 'auth', token })}\n${JSON.stringify(frame)}\n`;
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(pipe);
    const fail = (why: string): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`Could not write to \`${session.name}\`'s message pipe: ${why}`));
    };
    const timer = setTimeout(() => fail(`no close within ${timeoutMs} ms`), timeoutMs);
    socket.on('connect', () => socket.end(payload));
    socket.on('error', (err) => fail(err.message));
    socket.on('close', (hadError) => {
      clearTimeout(timer);
      if (!hadError) resolve();
    });
    socket.resume();
  });
}
