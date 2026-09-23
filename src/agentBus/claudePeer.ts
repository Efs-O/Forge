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

function normalizeDir(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `cwd` is one of `roots` or inside one. */
export function inRoots(cwd: string, roots: string[]): boolean {
  if (!cwd) return false;
  const c = normalizeDir(cwd);
  return roots.some((r) => {
    const root = normalizeDir(r);
    return c === root || c.startsWith(root + path.sep);
  });
}

function describe(s: ClaudeSession): string {
  const started = s.startedAt ? `, started ${new Date(s.startedAt).toLocaleTimeString()}` : '';
  return `- \`${s.name}\` (${s.status}${started}, ${s.cwd || 'no folder'})`;
}

const PIN_HINT =
  'To skip this choice, the user names a session with /rename in Claude Code and sets ' +
  '`agent_bus.claude_session: <name>` in config.yaml.';

/**
 * The one session a message goes to, or the reason there is none. With a name,
 * any live session of that name (any folder). Without one, the only live
 * non-SDK session in this workspace. Never a guess between several.
 */
export function pickClaudeSession(
  sessions: ClaudeSession[],
  wanted: string | undefined,
  roots: string[],
): { session: ClaudeSession } | { error: string } {
  if (wanted) {
    const matches = sessions.filter((s) => s.name.toLowerCase() === wanted.toLowerCase());
    if (matches.length === 1) return { session: matches[0] };
    const list = sessions.length ? `\n\nOpen sessions:\n${sessions.map(describe).join('\n')}` : '';
    return {
      error:
        matches.length > 1
          ? `Several live Claude sessions are named \`${wanted}\`, so nothing was sent. Ask the user to rename one.${list}`
          : `No live Claude Code session is named \`${wanted}\`, so nothing was sent.${list}`,
    };
  }
  const local = sessions.filter((s) => !s.sdk && inRoots(s.cwd, roots));
  if (local.length === 1) return { session: local[0] };
  if (local.length === 0) {
    const elsewhere = sessions.filter((s) => !s.sdk);
    const list = elsewhere.length
      ? ` Sessions open in other folders (pass one as \`session\`):\n${elsewhere.map(describe).join('\n')}`
      : ' The user has to open one first.';
    return {
      error: `No live Claude Code session is open in this workspace, so nothing was sent.${list}`,
    };
  }
  return {
    error:
      'Several Claude Code sessions are open in this workspace, so nothing was sent. Ask the ' +
      `user which one (ask_user), then call again with \`session\`:\n${local.map(describe).join('\n')}\n\n${PIN_HINT}`,
  };
}

/**
 * {@link pickClaudeSession} with the mesh's preferences. An explicit name is
 * strict (the caller named it). Otherwise: the session that joined itself
 * (`forge.sh join`, by pid), then the config pin, then the only open session
 * in this workspace. A joined pid that died or a pin naming a session that no
 * longer exists (names change on restart) is skipped rather than refused:
 * both are hints, and refusing on them is what made the user rename sessions.
 */
export function pickClaudePeer(
  sessions: ClaudeSession[],
  prefs: {
    explicit?: string | undefined;
    /** The `forge.sh join` record. A VS Code reload restarts the session under
     *  a new pid with the same sessionId, so either identifies it. */
    joined?: { pid: number; sessionId?: string | undefined } | undefined;
    pin?: string | undefined;
  },
  roots: string[],
): { session: ClaudeSession } | { error: string } {
  if (prefs.explicit) return pickClaudeSession(sessions, prefs.explicit, roots);
  const j = prefs.joined;
  if (j) {
    const joined =
      sessions.find((s) => s.pid === j.pid) ??
      (j.sessionId ? sessions.find((s) => s.sessionId === j.sessionId) : undefined);
    if (joined) return { session: joined };
    // Never hand a joined user's question to some other session: the user
    // chose this one, and a stand-in answers without their context.
    return {
      error:
        'the Claude session that joined as "claude" is not running (a VS Code reload ' +
        'stops it until its panel is opened again). Ask the user to open it, then retry',
    };
  }
  if (prefs.pin) {
    const pinned = pickClaudeSession(sessions, prefs.pin, roots);
    if ('session' in pinned) return pinned;
  }
  return pickClaudeSession(sessions, undefined, roots);
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
