import { registerAlias } from './aliasRegistry';
import type { HostLivenessDeps } from './hostIdentity';
import type { JoinResult } from './claudeJoin';

/** Register the current interactive Codex thread as the user-owned `codex` alias. */
export function joinCodex(
  root: string,
  alias: string,
  threadId: string,
  deps: HostLivenessDeps = {},
): JoinResult {
  if (alias !== 'codex') return { ok: false, error: `only "codex" can join (got "${alias}")` };
  const id = threadId.trim();
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
    return { ok: false, error: 'thread must be a non-empty Codex thread id' };
  }
  registerAlias(
    root,
    alias,
    { agent: 'codex', session_id: id, registered_at: Date.now(), by: 'user' },
    deps,
  );
  return { ok: true, reply: `joined as "${alias}" (thread ${id})` };
}
