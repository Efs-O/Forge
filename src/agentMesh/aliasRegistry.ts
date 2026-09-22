import * as fs from 'fs';
import * as path from 'path';
import { withLock } from './lock';
import type { HostLivenessDeps } from './hostIdentity';

/**
 * Session identity for the agent mesh (AGENT_MESH_PLAN §0, §4).
 *
 * Each agent has a stable **alias** (`codex`, `claude`) mapped to a session
 * identity in `~/.forge/agent-bus/aliases.json`. After a compaction Forge
 * resolves by alias, never by remembering a human-readable name — a name is
 * never the sole identity.
 *
 * The `config.yaml` `codex_thread` / `claude_session` values become
 * **deprecated pins**: an alias wins; a pin is used only if no alias exists and
 * the pin's session is live. `config.yaml` is never written back by code, so
 * the alias record lives in the bus folder, not the config.
 */

export const ALIASES_FILE_NAME = 'aliases.json';

/** The interprocess lock that serializes alias read-modify-write (F-14). */
export const ALIASES_LOCK_NAME = 'aliases.lock';

function aliasesLockPath(root: string): string {
  return path.join(root, ALIASES_LOCK_NAME);
}

export type AgentKind = 'claude' | 'codex';

export interface AliasRecord {
  agent: AgentKind;
  /** The session identity (a Claude session name, or a Codex thread id). */
  session_id: string;
  registered_at: number;
  /** Who registered it: 'user' (consented) or 'forge' (first owned creation). */
  by: 'user' | 'forge';
  /**
   * A user-opened Claude Code session that joined itself (`forge.sh join`):
   * its pid in `~/.claude/sessions`. Delivery goes to its peer pipe while that
   * pid is live; such a record is never resumed as a Forge-owned session.
   */
  peer_pid?: number;
  /** The joined session's conversation id: survives the pid change of a resume. */
  claude_session_id?: string;
}

/** The joined-session identity `pickClaudePeer` matches, or undefined if not joined. */
export function joinedPeer(
  rec: AliasRecord | undefined,
): { pid: number; sessionId?: string | undefined } | undefined {
  if (rec?.peer_pid === undefined) return undefined;
  return { pid: rec.peer_pid, sessionId: rec.claude_session_id };
}

export type AliasTable = Record<string, AliasRecord>;

export function aliasesPath(root: string): string {
  return path.join(root, ALIASES_FILE_NAME);
}

/** Read the alias table. Absent or corrupt → empty (recovery input, not fatal). */
export function readAliases(root: string): AliasTable {
  let raw: string;
  try {
    raw = fs.readFileSync(aliasesPath(root), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // corrupt: treat as empty; the next write repairs it
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: AliasTable = {};
  for (const [alias, rec] of Object.entries(parsed as Record<string, unknown>)) {
    const r = rec as Partial<AliasRecord> | null;
    if (
      r &&
      typeof r === 'object' &&
      (r.agent === 'claude' || r.agent === 'codex') &&
      typeof r.session_id === 'string' &&
      r.session_id.trim().length > 0
    ) {
      out[alias] = {
        agent: r.agent,
        session_id: r.session_id,
        registered_at: typeof r.registered_at === 'number' ? r.registered_at : 0,
        by: r.by === 'user' ? 'user' : 'forge',
        ...(typeof r.peer_pid === 'number' && r.peer_pid > 0 ? { peer_pid: r.peer_pid } : {}),
        ...(typeof r.claude_session_id === 'string' && r.claude_session_id.length > 0
          ? { claude_session_id: r.claude_session_id }
          : {}),
      };
    }
  }
  return out;
}

/** Write the alias table atomically (tmp + rename). */
export function writeAliases(root: string, table: AliasTable): void {
  const file = aliasesPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Register (or re-point) an alias. Returns the new table.
 *
 * F-14: the read-modify-write is serialized under the alias lock, so two
 * extension hosts registering different aliases concurrently cannot each rename
 * a whole table based on a stale read and silently drop the other's alias.
 */
export function registerAlias(
  root: string,
  alias: string,
  record: AliasRecord,
  deps: HostLivenessDeps = {},
): AliasTable {
  return withLock(aliasesLockPath(root), deps, 5_000, () => {
    const table = readAliases(root);
    table[alias] = record;
    writeAliases(root, table);
    return table;
  });
}

/**
 * Remove an alias (the user's command). Returns the new table.
 * F-14: serialized under the alias lock (same read-modify-write race).
 */
export function removeAlias(root: string, alias: string, deps: HostLivenessDeps = {}): AliasTable {
  return withLock(aliasesLockPath(root), deps, 5_000, () => {
    const table = readAliases(root);
    delete table[alias];
    writeAliases(root, table);
    return table;
  });
}

export function getAlias(root: string, alias: string): AliasRecord | undefined {
  return readAliases(root)[alias];
}

export function listAliases(root: string): AliasTable {
  return readAliases(root);
}

/**
 * Resolve the session identity for an alias, applying the deprecated-pin rule
 * (§0): the alias record wins; otherwise a pin (the config value) is used only
 * when provided. Returns the identity and whether it came from an alias.
 */
export function resolveSessionIdentity(
  root: string,
  alias: string,
  pin: string | undefined,
): { session_id: string; fromAlias: boolean } | undefined {
  const rec = getAlias(root, alias);
  if (rec) return { session_id: rec.session_id, fromAlias: true };
  if (pin) return { session_id: pin, fromAlias: false };
  return undefined;
}
