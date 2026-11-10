import { z } from 'zod';
import { ForgeConfigShape } from './schema';
import { EnginesSchema, ModelHostsSchema } from './engineSchema';

/**
 * The shape of `~/.forge/policy.yaml` — the file the OWNER edits and an agent
 * may not. It holds every key that widens what an agent can reach, plus every
 * program Forge runs: the permissions, the host and root lists, the agent bus,
 * the remote and job settings, the MCP servers, and the `engines` that say how a
 * server process is started and stopped.
 *
 * The blocks are picked out of `ForgeConfigShape` instead of restated, so the two
 * files cannot drift: a field added to `permissions` is validated in policy.yaml
 * the same second it is validated in config.yaml.
 *
 * Phase 2 accepts a policy key in EITHER file, because the owner runs the
 * migration by hand and both halves of a half-migrated pair must load. A key in
 * both at once is a load error (`PolicyLoader.ts`) that names it, never a silent
 * merge: which file wins is not something a half-migrated pair should decide by
 * accident. Phase 3 takes the policy keys out of config.yaml's schema entirely
 * (`test/unit/ConfigPolicyKeyCensus.test.ts` keeps them out for good).
 */

/** Top-level keys that belong in policy.yaml. The rule that produced this list
 *  (plan §3, widened by the owner on 2026-11-02): a block goes to policy if it
 *  changes what an agent may do — widening OR narrowing — or names a program Forge
 *  runs (`binary`, `executable`, `command`, `start_command`, `stop_command`,
 *  `*_binary`). An agent that can edit `exec.denylist_extra` can delete the
 *  owner's deny entries, so narrowing counts: a key an agent can LOOSEN belongs in
 *  the owner's file just as much as one it can WIDEN.
 *
 *  Blocks that only tune models stay in config.yaml, where an agent can edit them
 *  from phase 3 on: `defaults`, `profiles`, `groups`, `models`, `auto_compact`,
 *  `embeddings`, `benchmark`, `record_requests`, `elapsed_time_note`, and `tools`
 *  (whose only fields are line counts, globs, and how long to wait for the
 *  language service after a write — nothing an agent could reach with).
 *
 *  `search` and `image_search` moved here on the same rule: `provider` and
 *  `fallback` choose which external service receives the agent's query text, and
 *  `secret_key_name` chooses which SecretStorage token gets sent to it — an agent
 *  that could edit config.yaml from phase 3 could send a token it did not earn to
 *  a service it picked. `image_search.confirm_upload` is a gate setting too.
 *  A key cannot be split across both files, so the tuning fields in those blocks
 *  (`max_results`, `thumbnails`, `timeout_ms`) travel with them.
 */
export const POLICY_KEYS = [
  'permissions',
  'approvals',
  'clanker',
  'fetch',
  'exec',
  'browser',
  'search',
  'image_search',
  'agent_bus',
  'agent_links',
  'control_server',
  'cloud_relay',
  'model_starter',
  'remote',
  'jobs',
  'mcp_servers',
  'extra_file_roots',
  'templates_dir',
  'llama_server',
  'ollama',
  'image_generation',
  'voice',
  'engines',
  'model_hosts',
] as const;

export type PolicyKey = (typeof POLICY_KEYS)[number];

/** Allowed in both files: YAML anchors cannot cross a file boundary, so a policy
 *  file that wants its own anchors needs its own copy. Inert to Forge either way
 *  — Zod strips it, and `config.yaml`'s copy is the one the wizard maintains. */
export const SHARED_ANCHOR_KEY = 'x_shared';

export const PolicyConfigSchema = z.object({
  permissions: ForgeConfigShape.permissions,
  approvals: ForgeConfigShape.approvals,
  clanker: ForgeConfigShape.clanker,
  fetch: ForgeConfigShape.fetch,
  exec: ForgeConfigShape.exec,
  browser: ForgeConfigShape.browser,
  search: ForgeConfigShape.search,
  image_search: ForgeConfigShape.image_search,
  agent_bus: ForgeConfigShape.agent_bus,
  agent_links: ForgeConfigShape.agent_links,
  control_server: ForgeConfigShape.control_server,
  cloud_relay: ForgeConfigShape.cloud_relay,
  model_starter: ForgeConfigShape.model_starter,
  remote: ForgeConfigShape.remote,
  jobs: ForgeConfigShape.jobs,
  mcp_servers: ForgeConfigShape.mcp_servers,
  extra_file_roots: ForgeConfigShape.extra_file_roots,
  templates_dir: ForgeConfigShape.templates_dir,
  llama_server: ForgeConfigShape.llama_server,
  ollama: ForgeConfigShape.ollama,
  image_generation: ForgeConfigShape.image_generation,
  voice: ForgeConfigShape.voice,
  engines: EnginesSchema,
  model_hosts: ModelHostsSchema,
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

const policyKeySet = new Set<string>(POLICY_KEYS);

/** Every top-level key config.yaml accepts that policy.yaml does not — derived
 *  from the config schema so a new config key cannot quietly become acceptable
 *  in both files. */
const configOnlyKeySet = new Set<string>(
  Object.keys(ForgeConfigShape).filter((key) => !policyKeySet.has(key)),
);

export function isPolicyKey(key: string): boolean {
  return policyKeySet.has(key);
}

/** Is `key` a key config.yaml accepts (so a policy.yaml that names it holds a
 *  block that was written into the wrong file)? */
export function isConfigOnlyKey(key: string): boolean {
  return configOnlyKeySet.has(key);
}

/** The keys policy.yaml accepts, for an error that lists them rather than
 *  guessing what the owner meant. */
export function policyKeyList(): string[] {
  return [...POLICY_KEYS];
}
