import * as fs from 'fs';
import * as path from 'path';

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

export type AgentKind = 'claude' | 'codex';

export interface AliasRecord {
  agent: AgentKind;
  /** The session identity (a Claude session name, or a Codex thread id). */
  session_id: string;
  registered_at: number;
  /** Who registered it: 'user' (consented) or 'forge' (first owned creation). */
  by: 'user' | 'forge';
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
      typeof r.session_id === 'string'
    ) {
      out[alias] = {
        agent: r.agent,
        session_id: r.session_id,
        registered_at: typeof r.registered_at === 'number' ? r.registered_at : 0,
        by: r.by === 'user' ? 'user' : 'forge',
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

/** Register (or re-point) an alias. Returns the new table. */
export function registerAlias(root: string, alias: string, record: AliasRecord): AliasTable {
  const table = readAliases(root);
  table[alias] = record;
  writeAliases(root, table);
  return table;
}

/** Remove an alias (the user's command). Returns the new table. */
export function removeAlias(root: string, alias: string): AliasTable {
  const table = readAliases(root);
  delete table[alias];
  writeAliases(root, table);
  return table;
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
