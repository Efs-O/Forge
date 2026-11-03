import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  POLICY_KEYS,
  SHARED_ANCHOR_KEY,
  PolicyConfigSchema,
  isConfigOnlyKey,
  isPolicyKey,
  policyKeyList,
} from './policySchema';
import { ENGINE_EXEC_FIELDS } from './engineSchema';
import { validateRuleKey, type ApprovalKeyContext } from '../sidebar/approvalKey';

/**
 * Reading and checking `~/.forge/policy.yaml` — the owner's file, beside the
 * session logs, the jobs and the skills, NOT beside `config.yaml`. It is
 * machine-wide on purpose: a policy file inside a workspace is inside an agent's
 * reach, and the whole point of the split is that an agent cannot widen its own
 * permissions by editing a file it can also write.
 *
 * Enforcement turns on with the file. While `~/.forge/policy.yaml` does not exist
 * the pair loads exactly as phase 2 left it: `config.yaml` may hold any policy key,
 * because there is nowhere else for it to live, and `ownerPaths.ts` keeps that file
 * owner-only for the same reason. Once the file exists — whether the owner ran the
 * migration or made it by hand — `config.yaml` may not hold a policy key, may not
 * name a program Forge runs, and may not point a model at a host the owner did not
 * allow, because from that moment an agent can edit `config.yaml`. The gate is the
 * file and not a flag, because the file is the fact that matters: the guards can
 * only leave `config.yaml` once there is somewhere else for them to live. It fails
 * closed — delete policy.yaml and the owner-only wall on config.yaml is back.
 *
 * Two rules hold in both states. A key in BOTH files is an error naming it, never a
 * merge: which copy wins would otherwise be decided by the order the loader happens
 * to read them in, and a stale copy in one file could quietly out-veto the owner's
 * edit in the other; that is also the rule that makes a migration interrupted
 * between its two writes safe to leave sitting. And policy.yaml may not hold a
 * config.yaml-only key (`assertPolicyKeys`), which the merged schema would otherwise
 * accept as if the agent could not edit it.
 *
 * vscode-free: `loadConfig` is used from plain node in tests and by the remote
 * runtime, and a policy file must parse the same way in both.
 */

/** The file name, so `ConfigWriter` can tell the two files apart by name. */
export const POLICY_FILENAME = 'policy.yaml';

/** `~/.forge/policy.yaml`. Injectable (a fixture copy in tests) but never
 *  per-workspace: `policySchema.ts`'s contract is one machine-wide policy.
 *
 *  There is deliberately no environment override. An agent's own shell can set
 *  one — `setx FORGE_POLICY_PATH <workspace>\p.yaml` would make the next VS Code
 *  start read its permissions, its host list and its engines from a file the
 *  agent can write, which is exactly what phase 3's lock exists to prevent. The
 *  tests stay hermetic by stubbing this function instead
 *  (`test/support/tempGuard.setup.ts`), and `test/unit/PolicyLoader.test.ts`
 *  fails if a `src/` file starts reading such a variable again.
 */
export function defaultPolicyPath(home?: string): string {
  return path.join(home ?? os.homedir(), '.forge', POLICY_FILENAME);
}

export interface YamlFileState {
  path: string;
  /** False when the file does not exist. An empty or comment-only file exists
   *  with `raw` empty, which is a different thing from absent: the migration
   *  refuses a file that has content and writes into one that does not. */
  exists: boolean;
  raw: Record<string, unknown>;
}

/** Load a Forge YAML file as a top-level map: absent → `{ exists: false }`; a
 *  parse failure or a top-level scalar/list throws naming the file. A file whose
 *  whole content is `null` or comments loads as an empty map. */
export function readYamlMapFile(filePath: string): YamlFileState {
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false, raw: {} };
  const text = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (err) {
    throw new Error(
      `Forge: ${path.basename(filePath)} parse failed:\n  • ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === undefined || parsed === null) return { path: filePath, exists: true, raw: {} };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Forge: ${path.basename(filePath)} must be a map of top-level keys, not a list or a plain value.`,
    );
  }
  return { path: filePath, exists: true, raw: parsed as Record<string, unknown> };
}

export function readPolicyFile(policyPath: string): YamlFileState {
  return readYamlMapFile(policyPath);
}

/** Does this policy file hold anything an owner would notice — a key, or text
 *  that is not just whitespace and comments? The migration refuses to overwrite a
 *  file that does, and never guesses which of two policies to keep. */
export function policyFileHasContent(state: YamlFileState): boolean {
  if (!state.exists) return false;
  if (Object.keys(state.raw).length > 0) return true;
  return state.path === ''
    ? false
    : hasNonCommentText(fs.existsSync(state.path) ? fs.readFileSync(state.path, 'utf8') : '');
}

function hasNonCommentText(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Every top-level key policy.yaml actually accepts. A key that config.yaml owns
 * (an `active_model` pasted into policy.yaml) and an unrecognised key get
 * different messages: the first is "that belongs in the other file", the second
 * is "policy.yaml accepts these and nothing else". Without the first, a
 * mis-placed block still validates — ForgeConfigSchema accepts every key — and
 * the owner gets a config that works while reading as if the agent could edit
 * that key, which is the mistake this whole split exists to prevent.
 */
export function assertPolicyKeys(state: YamlFileState): void {
  for (const key of Object.keys(state.raw)) {
    if (key === SHARED_ANCHOR_KEY || isPolicyKey(key)) continue;
    const where = isConfigOnlyKey(key)
      ? `it belongs in config.yaml, the file an agent may edit`
      : `policy.yaml accepts only: ${policyKeyList().join(', ')}`;
    throw new Error(`Forge: policy.yaml has "${key}", which ${where} (${state.path}).`);
  }
}

/** Validate the VALUES of the policy blocks. The keys are checked first by
 *  `assertPolicyKeys` (friendlier), so what is left here is a bad value inside a
 *  block that is in the right file. */
export function assertPolicyValues(state: YamlFileState): void {
  const result = PolicyConfigSchema.safeParse(state.raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  • policy.yaml: ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Forge: policy.yaml validation failed:\n${issues}\n(${state.path})`);
  }
  assertApprovalPolicyKeys(state, result.data.approvals);
}

/** Approval keys in the owner file use the same grammar and protected-folder
 *  exclusions as chat rules. This runs at load time, before any rule can answer a
 *  card; malformed owner input names its exact policy path instead of silently
 *  becoming an ineffective or wider rule. */
function assertApprovalPolicyKeys(
  state: YamlFileState,
  approvals: NonNullable<import('./policySchema').PolicyConfig['approvals']> | undefined,
): void {
  if (!approvals) return;
  const platform = process.platform;
  const home = path.dirname(path.dirname(state.path));
  const base: ApprovalKeyContext = {
    platform,
    home,
    ownerOnly: [path.dirname(state.path)],
    extraFileRoots: [],
    workspaceRoot: undefined,
  };
  const issues: string[] = [];
  const check = (key: string, location: string, workspaceRoot?: string): void => {
    if (key !== key.trim()) {
      issues.push(
        `  • policy.yaml: ${location}: approval key must not have surrounding whitespace`,
      );
      return;
    }
    const context = { ...base, ...(workspaceRoot ? { workspaceRoot } : {}) };
    const problem = validateRuleKey(key, context);
    if (problem) issues.push(`  • policy.yaml: ${location}: ${key}: ${problem}`);
  };
  for (const [index, rule] of (approvals.always ?? []).entries()) {
    if (rule.workspace !== undefined && !path.isAbsolute(rule.workspace)) {
      issues.push(
        `  • policy.yaml: approvals.always.${index}.workspace: expected an absolute path`,
      );
    }
    check(rule.key, `approvals.always.${index}.key`, rule.workspace);
  }
  for (const [jobId, rule] of Object.entries(approvals.jobs ?? {})) {
    for (const [index, key] of rule.allow.entries()) {
      check(key, `approvals.jobs.${jobId}.allow.${index}`);
    }
  }
  for (const [index, key] of (approvals.unattended_bus?.allow ?? []).entries()) {
    check(key, `approvals.unattended_bus.allow.${index}`);
  }
  if (issues.length > 0) {
    throw new Error(`Forge: policy.yaml validation failed:\n${issues.join('\n')}\n(${state.path})`);
  }
}

/**
 * The phase-2 rule that keeps a half-migrated pair honest: a top-level key in
 * both files is an error naming the key and both paths. `x_shared` is exempt —
 * YAML anchors cannot cross a file boundary, so each file may keep its own copy,
 * and neither copy is a setting anything could merge.
 */
export function assertNoSharedKeys(
  configState: YamlFileState,
  policyState: YamlFileState,
): string[] {
  const both: string[] = [];
  for (const key of Object.keys(policyState.raw)) {
    if (key === SHARED_ANCHOR_KEY) continue;
    if (Object.prototype.hasOwnProperty.call(configState.raw, key)) both.push(key);
  }
  if (both.length === 0) return both;
  throw new Error(
    `Forge: ${both.map((key) => `"${key}"`).join(', ')} in both config.yaml (${configState.path})\n` +
      `and policy.yaml (${policyState.path}). Keep each key in one file: delete the copy you\n` +
      `do not want, or run "Forge: Move security settings to policy.yaml" to move the whole\n` +
      `policy side out of config.yaml for you. Forge does not merge the two — which file wins\n` +
      `would otherwise depend on the order these files were read, not on what you wrote.`,
  );
}

/**
 * Whether the split is ENFORCED: `~/.forge/policy.yaml` exists.
 *
 * The file is the gate because the file is the fact that matters: the guards can
 * only leave `config.yaml` once there is somewhere else for them to live, and the
 * migration is owner-run, so an install that has not run it keeps phase 2's
 * behaviour — `config.yaml` owner-only (`ownerPaths.ts`), its policy keys read from
 * it, a setup message naming the file. It fails closed: delete policy.yaml and the
 * owner-only wall on config.yaml is back.
 *
 * Every caller asks again on the spot — `loadConfig` on each load, the owner-only
 * guard on each decision, the watcher on each change — and never caches the answer
 * for the life of a window: a remembered "present" would leave config.yaml open to
 * agents after the owner removed the file that made opening it safe.
 */
export function policyEnforced(policyState: YamlFileState): boolean {
  return policyState.exists;
}

/** The policy keys sitting in `config.yaml`, in the order the file lists them.
 *  `x_shared` is not one of them: it is allowed in both files (`policySchema.ts`),
 *  because a YAML anchor cannot cross a file boundary and neither copy is a setting
 *  anything could merge. */
export function policyKeysInConfig(configState: YamlFileState): string[] {
  return Object.keys(configState.raw).filter(
    (key) => key !== SHARED_ANCHOR_KEY && isPolicyKey(key),
  );
}

/**
 * Phase 3: once policy.yaml exists, `config.yaml` may not hold a policy key.
 *
 * Why the existence of the other file is the condition rather than a version: the
 * same phase that refuses these keys is the one that opens `config.yaml` to agents,
 * and the two only make sense together. Opening the file while its `permissions`
 * block was still inside it would let an agent edit the block that says what an
 * agent may do — which is the thing this whole plan exists to prevent. Before the
 * owner migrates there is nowhere to move the keys, so the load stays as phase 2
 * left it and `ownerPaths.ts` keeps that file owner-only.
 */
export function assertConfigFileKeys(configState: YamlFileState, policyState: YamlFileState): void {
  const found = policyKeysInConfig(configState);
  if (!policyEnforced(policyState) || found.length === 0) return;
  throw new Error(
    `Forge: config.yaml holds ${found.length} policy key${found.length === 1 ? '' : 's'}:\n` +
      `  ${found.join(', ')}\n` +
      `Those blocks say what an agent may do, and from phase 3 an agent can edit\n` +
      `config.yaml, so they belong in ${policyState.path} — the owner's file, which an\n` +
      'agent may not write. Run "Forge: Move security settings to policy.yaml": it backs\n' +
      'up config.yaml, writes them into policy.yaml and deletes them from config.yaml,\n' +
      `and then this load succeeds.\n(${configState.path})`,
  );
}

/** Field names that say "a program Forge runs" — the plan's §3 CI vocabulary,
 *  widened to the matching suffixes so a later phase that invents
 *  `video.ffmpeg_binary` is refused by this rule rather than by whoever remembers
 *  to add the name. `test/unit/ConfigPolicyKeyCensus.test.ts` pins the list. */
const EXEC_NAME_WORDS = new Set([
  'binary',
  'executable',
  'command',
  'start_command',
  'stop_command',
]);
const EXEC_NAME_SUFFIXES = ['_binary', '_executable', '_command'];

export function isExecNamedField(name: string): boolean {
  const key = name.toLowerCase();
  return EXEC_NAME_WORDS.has(key) || EXEC_NAME_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/** A field in `config.yaml` that names a program Forge runs, or one of the four
 *  fields the migration turns into an engine (`unload_path` names no program, but it
 *  is an engine's field and lands in the same engine, so it moves with them). */
export interface ExecFieldHit {
  /** `models[2].start_command` — the path the owner can find in the file. */
  path: string;
  /** The field name, which is what the message refuses. */
  field: string;
  /** Set when the hit is inside a model entry, so the message can name the model. */
  model?: string;
}

/** Join path parts the way an owner reads them in a YAML file: `models[2].start_command`. */
function joinPath(parent: string, part: string): string {
  return !parent ? part : part.startsWith('[') ? `${parent}${part}` : `${parent}.${part}`;
}

/** Every program-named field in the half of `config.yaml` an agent would own.
 *  Policy blocks are skipped: before the owner migrates, `llama_server.binary` and
 *  `mcp_servers[].command` have always lived in config.yaml and are legal there,
 *  and once policy.yaml exists they are refused by name (`assertConfigFileKeys`), so
 *  nothing inside them is left to judge. */
export function execFieldsInConfig(configState: YamlFileState): ExecFieldHit[] {
  const hits: ExecFieldHit[] = [];
  const walk = (value: unknown, path: string, model: string | undefined, engineFields: boolean) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, joinPath(path, `[${index}]`), model, false));
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const fieldPath = joinPath(path, key);
      const engineField = engineFields && (ENGINE_EXEC_FIELDS as readonly string[]).includes(key);
      if (isExecNamedField(key) || engineField) {
        hits.push(
          model === undefined
            ? { path: fieldPath, field: key }
            : { path: fieldPath, field: key, model },
        );
      }
      walk(child, fieldPath, model, false);
    }
  };
  for (const [top, value] of Object.entries(configState.raw)) {
    if (top === SHARED_ANCHOR_KEY || isPolicyKey(top)) continue;
    if (top === 'models' && Array.isArray(value)) {
      value.forEach((entry, index) => {
        const name = (entry as { name?: unknown } | undefined)?.name;
        walk(entry, `models[${index}]`, typeof name === 'string' ? name : undefined, true);
      });
      continue;
    }
    walk(value, top, undefined, false);
  }
  return hits;
}

/**
 * Phase 3: once policy.yaml exists, `config.yaml` may not name a program Forge
 * runs, and may not carry the four fields that say how a server is started and
 * stopped. A model entry that could name its own `start_command` let an agent point
 * Forge at any executable on this machine and Forge would run it on the next load —
 * which is why the engine lives in the owner's file and a model says only
 * `engine: <name>` (`engineSchema.ts`).
 */
export function assertNoExecFieldsInConfig(
  configState: YamlFileState,
  policyState: YamlFileState,
): void {
  if (!policyEnforced(policyState)) return;
  const hits = execFieldsInConfig(configState);
  if (hits.length === 0) return;
  const byModel = new Map<string, string[]>();
  const elsewhere: string[] = [];
  for (const hit of hits) {
    if (hit.model !== undefined) {
      const fields = byModel.get(hit.model) ?? [];
      if (!fields.includes(hit.field)) fields.push(hit.field);
      byModel.set(hit.model, fields);
    } else if (!elsewhere.includes(hit.path)) elsewhere.push(hit.path);
  }
  const lines = [...byModel].map(([name, fields]) => `  • model "${name}": ${fields.join(', ')}`);
  lines.push(...elsewhere.map((path) => `  • ${path}`));
  throw new Error(
    `Forge: config.yaml names programs Forge runs, and an agent can edit that file,\n` +
      `so each of these belongs in ${policyState.path} as an engine (the owner's file):\n` +
      `${lines.join('\n')}\n` +
      'Run "Forge: Move security settings to policy.yaml": it writes one engine per model\n' +
      'that names its own server, leaves `engine: <name>` where the fields were, and\n' +
      `backs up config.yaml first. A field that is not a model's server program has to\n` +
      'be moved by hand into the block that owns it in policy.yaml.\n' +
      `(${configState.path})`,
  );
}

/** The merged view every consumer sees: config.yaml's keys, with policy.yaml's
 *  blocks layered on. A key in both is already refused above, so the order here
 *  cannot change the answer — it only lets a policy key live in either file while
 *  the owner has not run the migration yet. */
export function mergeConfigAndPolicy(
  configState: YamlFileState,
  policyState: YamlFileState,
): Record<string, unknown> {
  return { ...configState.raw, ...policyState.raw };
}

/** The policy keys, for a phase-3 test that pins config.yaml's schema to the
 *  non-policy half (`ConfigPolicyKeyCensus.test.ts`). */
export function policyKeys(): readonly string[] {
  return POLICY_KEYS;
}
