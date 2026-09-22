import { PEER_PROTOCOL, readClaudeSessions, type ClaudeSession } from '../agentBus/claudePeer';
import { registerAlias } from './aliasRegistry';

export type JoinResult = { ok: true; reply: string } | { ok: false; error: string };

/**
 * `forge.sh join claude` (AGENT_MESH_PLAN §10): a user-opened Claude Code
 * session registers itself as the `claude` alias by its pid, so nobody has to
 * rename a session or edit a config pin. The record carries `peer_pid`, which
 * marks it as joined: the provider reaches it through its peer pipe while the
 * pid lives and never resumes it headless (that session belongs to the user).
 * A dead pid is skipped on the next resolution, not refused.
 */
export function joinClaude(
  root: string,
  alias: string,
  pid: number,
  sessions: ClaudeSession[] = readClaudeSessions(),
): JoinResult {
  if (alias !== 'claude') return { ok: false, error: `only "claude" can join (got "${alias}")` };
  if (!Number.isInteger(pid) || pid <= 0)
    return { ok: false, error: 'pid must be a positive integer' };
  const session = sessions.find((s) => s.pid === pid);
  if (!session) {
    return { ok: false, error: `no live interactive Claude Code session has pid ${pid}` };
  }
  if (!session.pipe || session.peerProtocol !== PEER_PROTOCOL) {
    return {
      ok: false,
      error: `session \`${session.name}\` has no peer pipe Forge can write to (protocol ${session.peerProtocol ?? 'none'})`,
    };
  }
  registerAlias(root, alias, {
    agent: 'claude',
    session_id: session.name,
    peer_pid: pid,
    ...(session.sessionId ? { claude_session_id: session.sessionId } : {}),
    registered_at: Date.now(),
    by: 'user',
  });
  return { ok: true, reply: `joined as "${alias}" (session \`${session.name}\`, pid ${pid})` };
}
