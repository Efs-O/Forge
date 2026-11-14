import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ForgeConfigSchema } from './schema';
import { ENGINE_EXEC_FIELDS, engineNameForModel } from './engineSchema';
import {
  defaultPolicyPath,
  readPolicyFile,
  readYamlMapFile,
  assertPolicyKeys,
  assertPolicyValues,
  assertNoSharedKeys,
  assertConfigFileKeys,
  assertNoExecFieldsInConfig,
  policyEnforced,
  policyKeysInConfig,
  mergeConfigAndPolicy,
} from './PolicyLoader';
import type { YamlFileState } from './PolicyLoader';
import type { ForgeConfig } from './types';
import { checkConfigCrossRefs } from './configChecks';
import { effectiveGroupField } from './modelSchema';
import { endpointHostOf, isLoopbackHost } from './policyYamlNodes';
import { leftoverWarningText, modelRefKey, type ModelReference } from './modelReferences';
import { permissionsSuppressedByBlock } from '../tools/PermissionResolver';
import { MAX_FILE_SETTLE_ROUNDS, runWhenFilesSettled, snapshotWatchedFiles } from './fileSettle';
import { getLogger } from '../util/logger';

const CONFIG_FILENAME = 'config.yaml';

export interface LoadConfigOptions {
  /** `~/.forge/policy.yaml` by default. A test passes a fixture copy — that is
   *  the only reason this is open, since the policy file is machine-wide by
   *  contract (`policySchema.ts`) and a workspace copy would be in an agent's
   *  reach.
   */
  policyPath?: string;
}

/**
 * Load the pair every consumer sees: `config.yaml` in `storagePath`, with
 * `~/.forge/policy.yaml` layered beside it. Absent policy file = today's
 * behaviour, key for key, which is what phase 2 promises: the split is only real
 * once the owner runs the migration command, and until then both files may hold
 * any key — except the same key in both at once, which is refused by name
 * (`PolicyLoader.ts`) rather than merged.
 */
export function loadConfig(storagePath: string, options: LoadConfigOptions = {}): ForgeConfig {
  const filePath = path.join(storagePath, CONFIG_FILENAME);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Forge: config.yaml not found at ${filePath}.\n` +
        `Create .forge/config.yaml in your workspace or use the setup wizard to generate one.`,
    );
  }

  const configState = readYamlMapFile(filePath);
  const policyPath = options.policyPath ?? defaultPolicyPath();
  const policyState = readPolicyFile(policyPath);
  if (policyState.exists) {
    assertPolicyKeys(policyState);
    assertPolicyValues(policyState);
    assertNoSharedKeys(configState, policyState);
  }

  // Phase 3's two config-side rules, both keyed to the same fact as the opening of
  // `config.yaml` itself: the policy file exists. Before it does, these keys have
  // nowhere else to live and `ownerPaths.ts` keeps `config.yaml` owner-only, so the
  // load stays as phase 2 left it. After it does, an agent owns this file, and a
  // key that says what an agent may do — or a program Forge runs — cannot be allowed
  // to sit in the file the agent can rewrite.
  assertConfigFileKeys(configState, policyState);
  assertNoExecFieldsInConfig(configState, policyState);

  const parsed = mergeConfigAndPolicy(configState, policyState);

  const result = ForgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    // Each line names the file that holds the top-level key, because "config.yaml
    // validation failed" pointing at a line the owner cannot find in config.yaml
    // is how a mis-placed policy block gets debugged by an hour of searching.
    const lines = result.error.issues.map((issue) => {
      const top = issue.path[0];
      const source =
        policyState.exists && typeof top === 'string' && policyState.raw[top] !== undefined
          ? policyPath
          : filePath;
      return `  • ${source}: ${issue.path.join('.')}: ${issue.message}`;
    });
    const first = result.error.issues[0];
    const firstTop = first?.path[0];
    const failingFile =
      policyState.exists && typeof firstTop === 'string' && policyState.raw[firstTop] !== undefined
        ? policyPath
        : filePath;
    throw new Error(`Forge: ${path.basename(failingFile)} validation failed:\n${lines.join('\n')}`);
  }

  const config = result.data as ForgeConfig;
  assertEnginesExist(config, policyPath);
  assertModelEndpoints(config, policyState);
  // An absent policy file is not an error: the owner has simply not run the
  // migration yet. It is the state in which `config.yaml` is still owner-only, and
  // the owner needs to be able to find out why their own config file is refusing
  // edits. It is logged, and `/config` says it out loud (`nativeCommands.ts`
  // `forge.openConfig` → `policyLockSentence` for an absent file), rather than
  // toasted: a toast that appears at every launch until the owner acts is noise
  // that trains them to dismiss the warnings that do mean something, and
  // `loadConfig` runs on a hot reload every 150 ms.
  if (!policyState.exists) {
    getLogger().info(policySetupMessage(policyPath, policyKeysInConfig(configState)));
  }
  warnOnDeprecatedKeys(parsed);
  // The cross-block checks `ConfigWriter.updateConfigFile` also runs, so a
  // write can never produce a file this loader then refuses. A reference that
  // names a deleted model is not one of these errors: it comes back as a
  // leftover and is reported below, never silently rewritten away.
  const leftovers = checkConfigCrossRefs(config);
  // A selection naming a deleted model becomes "no model active" — the state
  // `active_model: none` already produces, which the send path ("Pick a model
  // before sending") and the model picker handle. Nothing here guesses a
  // replacement for a choice the user made.
  if (leftovers.some((row) => row.kind === 'active_model')) config.active_model = null;

  warnOnSuppressedPermissions(config);
  warnOnModelExecFields(config, policyPath);
  reportLeftoverModelRefs(filePath, leftovers);
  return config;
}

/** A model naming an engine Forge cannot find would start the wrong program, or
 *  none, and the only symptom would be a chat that never answers. The name is
 *  checked here, where the owner can read it, not at spawn time. */
function assertEnginesExist(config: ForgeConfig, policyPath: string): void {
  const engines = config.engines ?? {};
  for (const model of config.models) {
    if (!model.engine || engines[model.engine]) continue;
    throw new Error(
      `Forge: model "${model.name}" names engine "${model.engine}", which is not in\n` +
        `${policyPath} (configured engines: ${Object.keys(engines).join(', ') || 'none'}).\n` +
        "Add that engine to policy.yaml, or change the model's `engine:` line.",
    );
  }
}

/**
 * Phase 3: a model in `config.yaml` may reach only a host the owner allowed.
 *
 * `model_hosts` lives in policy.yaml, so without this rule an agent could add a
 * model pointing at any server on the internet and the chat — including any secret
 * it has read — would go there on the next message. Loopback is exempt: a server on
 * this machine is not a way out, and `policyMigration.ts` writes the non-loopback
 * hosts the config already uses into `model_hosts` as it moves, so a migrated owner
 * does not get this error for a tailnet server they have been using for months.
 */
function assertModelEndpoints(config: ForgeConfig, policyState: YamlFileState): void {
  if (!policyEnforced(policyState)) return;
  const allowed = new Set((config.model_hosts ?? []).map((entry) => hostListEntry(entry)));
  const rows: string[] = [];
  for (const model of config.models) {
    const endpoint = model.endpoint ?? effectiveGroupField(model, config.groups, 'endpoint');
    const host = endpointHostOf(endpoint);
    if (!host || isLoopbackHost(host) || allowed.has(host)) continue;
    rows.push(`  • model "${model.name}": ${endpoint} → ${host}`);
  }
  if (rows.length === 0) return;
  throw new Error(
    'Forge: these models name a host that is not this machine and is not in model_hosts\n' +
      `in ${policyState.path} (the owner's file):\n${rows.join('\n')}\n` +
      'Add each host to model_hosts there, or run "Forge: Move security settings to policy.yaml"\n' +
      'again, which writes the hosts these models already talk to for you. A model and its\n' +
      'host in the file an agent can edit would let that agent send the chat, and any\n' +
      `secret the chat has read, to a server the owner never chose.\n(${policyState.path})`,
  );
}

/** One entry of `model_hosts`, judged as a host: the owner may write either
 *  `100.64.0.10` or the full endpoint, and a list that refused the second spelling
 *  would send them back to the error it was supposed to solve. */
function hostListEntry(value: string): string {
  return (endpointHostOf(value) ?? value).toLowerCase();
}

/** The setup message phase 3 promises when there is no policy file: the file, what
 *  is still being read out of `config.yaml`, and the one command that fixes it. It
 *  warns rather than refuses because the state is legal — nothing has been moved
 *  yet — and because refusing it would stop a fresh install from starting at all.
 *  While this is the case `ownerPaths.ts` keeps `config.yaml` owner-only, so the
 *  guards are not open: the file is closed instead of moved. */
function policySetupMessage(policyPath: string, keysInConfig: string[]): string {
  const shown = keysInConfig.slice(0, 6).join(', ');
  const more = keysInConfig.length > 6 ? `, and ${keysInConfig.length - 6} more` : '';
  const held = keysInConfig.length
    ? `holding ${keysInConfig.length} security key${keysInConfig.length === 1 ? '' : 's'}\n  (${shown}${more})`
    : 'holding no security keys';
  return (
    `Forge: ${policyPath} does not exist, so config.yaml is still ${held}\n` +
    'and is therefore owner-only: an agent may not edit the file that says what an\n' +
    'agent may do. Run "Forge: Move security settings to policy.yaml" to split the\n' +
    'pair: that opens config.yaml to agents, and lets "Forge: Lock policy.yaml"\n' +
    'protect the policy file afterwards.'
  );
}

/** Phase 2: a model that still carries its own server programs loads and works
 *  exactly as before, but those lines are what the migration command turns into
 *  engines, and an owner who has never seen the engine list has no reason to
 *  expect the names it will get. Warn once, naming each model and the engine its
 *  fields belong in — the same rule `policyMigration.ts` uses, so the warning and
 *  the file it produces agree. */
function warnOnModelExecFields(config: ForgeConfig, policyPath: string): void {
  const rows = config.models.filter((model) =>
    ENGINE_EXEC_FIELDS.some((field) => model[field] !== undefined),
  );
  if (rows.length === 0) return;
  const shown = rows
    .slice(0, 6)
    .map((model) => `${model.name} → engine "${engineNameForModel(model)}"`);
  const more = rows.length > shown.length ? ` and ${rows.length - shown.length} more` : '';
  warnOnce(
    `Forge: ${rows.length} model${rows.length === 1 ? '' : 's'} in config.yaml still name their own\n` +
      `server programs (${shown.join(', ')}${more}). Each belongs in ${policyPath} as an engine.\n` +
      'Run "Forge: Move security settings to policy.yaml" to move them; until then they load\n' +
      'as they are.',
  );
}

/**
 * Report the references naming a model that is gone: one toast per distinct
 * set, the same lines in the output log, and an `Open config.yaml` button.
 * The watcher reloads on every save, so an unconditional toast would fire on
 * each keystroke-to-disk: the same set on a hot reload is not repeated, and a
 * load that finds none clears the set so a later regression can warn again.
 *
 * This is the rule that invalid config must never be masked — the config still
 * loads (a stale name must not brick every other config change) and the user
 * is told which paths are stale and what to do about them.
 */
const shownLeftoverSets = new Set<string>();

function reportLeftoverModelRefs(configPath: string, leftovers: ModelReference[]): void {
  if (leftovers.length === 0) {
    shownLeftoverSets.clear();
    return;
  }
  const setKey = leftovers
    .map((row) => modelRefKey(row))
    .sort()
    .join('\n');
  if (shownLeftoverSets.has(setKey)) return;
  shownLeftoverSets.add(setKey);
  const message = leftoverWarningText(leftovers);
  getLogger().warn(message);
  const choice = vscode.window.showWarningMessage(message, 'Open config.yaml');
  if (!choice) return;
  void choice
    .then((picked) =>
      picked === 'Open config.yaml'
        ? vscode.workspace.openTextDocument(vscode.Uri.file(configPath))
        : undefined,
    )
    .then((doc) => (doc ? vscode.window.showTextDocument(doc, { preview: false }) : undefined));
}
// The config watcher reloads on every save, so an unconditional toast would
// fire on each keystroke-to-disk. Warn once per distinct message per session.
const warnedMessages = new Set<string>();

/** One toast per distinct message per session, for a load-time warning that is
 *  not about a stale model reference (those get their own set, so a clean load
 *  can clear them and a later regression can warn again). */
function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  void vscode.window.showWarningMessage(message);
}

/**
 * A permissions block is all-or-nothing: naming one group makes the schema
 * defaults authoritative for every other group too. Capabilities then go dark
 * without ever being switched off, and the only visible symptom is a tool
 * missing from the model's list — which reads as a broken model, not as config.
 */
function warnOnSuppressedPermissions(config: ForgeConfig): void {
  const suppressed = permissionsSuppressedByBlock(config);
  if (suppressed.length === 0) return;
  const message =
    'Forge: a permissions block is present, so these capabilities are OFF by ' +
    `schema default rather than by choice: ${suppressed.join(', ')}. Their tools are ` +
    'not advertised to the model at all. Set each one explicitly in the permissions ' +
    'block — config.yaml, or ~/.forge/policy.yaml once you have run "Forge: Move ' +
    'security settings to policy.yaml" — if you want it.';
  warnOnce(message);
}

/**
 * Resolve explicit path from user settings: absolute path to config.yaml, or to a directory that contains it.
 * Returns null if empty, missing, or invalid.
 */
export function resolveExplicitConfigPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = path.normalize(trimmed);
  if (!fs.existsSync(normalized)) return null;
  const stat = fs.statSync(normalized);
  if (stat.isFile()) {
    return path.basename(normalized).toLowerCase() === CONFIG_FILENAME.toLowerCase()
      ? normalized
      : null;
  }
  if (stat.isDirectory()) {
    const candidate = path.join(normalized, CONFIG_FILENAME);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The same order as `findConfigPath` — explicit setting, then the workspace's
 * `.forge/config.yaml`, then global storage — for a folder this window does not
 * have open, which is what the target window of a workspace switch resolves.
 * One implementation, so the two cannot drift apart.
 */
export function findConfigPathFor(
  workspaceRoot: string | null,
  globalStoragePath: string,
  explicitConfigPathSetting?: string | null,
): string | null {
  const fromSetting = explicitConfigPathSetting
    ? resolveExplicitConfigPath(explicitConfigPathSetting)
    : null;
  if (fromSetting) return fromSetting;
  // Check workspace root first
  if (workspaceRoot) {
    const wsConfig = path.join(workspaceRoot, '.forge', CONFIG_FILENAME);
    if (fs.existsSync(wsConfig)) return wsConfig;
  }
  // Fall back to global storage
  const globalConfig = path.join(globalStoragePath, CONFIG_FILENAME);
  if (fs.existsSync(globalConfig)) return globalConfig;
  return null;
}

/**
 * Find config.yaml: optional absolute override (settings), then workspace .forge/, then global storage.
 * Returns the path if found, null otherwise.
 */
export function findConfigPath(
  globalStoragePath: string,
  explicitConfigPathSetting?: string | null,
): string | null {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  return findConfigPathFor(
    workspaceFolders?.length ? workspaceFolders[0].uri.fsPath : null,
    globalStoragePath,
    explicitConfigPathSetting,
  );
}

/**
 * Watch workspace `config.yaml` and optional extra absolute paths.
 * Debounces so saves that touch multiple files produce one reload.
 *
 * A save is not one atomic write, so the debounce alone is not enough: the reload
 * would read the first flushed chunk. The wait for the files to go quiet lives in
 * `fileSettle.ts`, and the reason it exists is documented there.
 */
export function watchForgeConfigPaths(
  primaryConfigYamlPath: string,
  extraAbsolutePaths: string[],
  onReload: (config: ForgeConfig | null, error?: Error) => void,
): vscode.Disposable {
  const forgeDir = path.dirname(primaryConfigYamlPath);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Reloads this function asked for itself, after finding the file had moved
   *  under the load. Bounded, so a file edited in a tight loop cannot reload the
   *  extension forever; a real save resets the count. */
  let driftRounds = 0;

  const reload = (): void => {
    const before = snapshotWatchedFiles([...normalizedSeen]);
    try {
      const loaded = loadConfig(forgeDir);
      onReload(loaded);
    } catch (err) {
      onReload(null, err instanceof Error ? err : new Error(String(err)));
    }
    // A flush that landed while the file was being read may never raise its own
    // event, and a half-read file that still parses is exactly the accident this
    // block exists to prevent. Compare the bytes on disk with the ones just read.
    if (
      snapshotWatchedFiles([...normalizedSeen]) !== before &&
      driftRounds < MAX_FILE_SETTLE_ROUNDS
    ) {
      driftRounds += 1;
      schedule();
    } else {
      driftRounds = 0;
    }
  };

  const schedule = (): void => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      runWhenFilesSettled({ paths: [...normalizedSeen], onLoad: reload });
    }, 150);
  };

  const normalizedSeen = new Set<string>();
  const watchers: vscode.Disposable[] = [];

  const watchOne = (absPath: string): void => {
    const normalized = path.normalize(absPath);
    if (normalizedSeen.has(normalized)) return;
    normalizedSeen.add(normalized);

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(normalized), path.basename(normalized)),
    );
    const onEvent = (uri: vscode.Uri): void => {
      const eventPath = path.normalize(uri.fsPath);
      const matches =
        process.platform === 'win32'
          ? eventPath.toLowerCase() === normalized.toLowerCase()
          : eventPath === normalized;
      if (matches) {
        driftRounds = 0;
        schedule();
      }
    };
    watcher.onDidChange(onEvent);
    watcher.onDidCreate(onEvent);
    watchers.push(watcher);
  };

  watchOne(primaryConfigYamlPath);
  // The policy file is machine-wide, so it is watched wherever it lives: an edit
  // to it reloads the same way an edit to config.yaml does, and a save that
  // touches both produces one reload, not two, because the debounce is shared.
  watchOne(defaultPolicyPath());
  for (const p of extraAbsolutePaths) watchOne(p);

  watchers.push(
    new vscode.Disposable(() => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    }),
  );

  return vscode.Disposable.from(...watchers);
}

/**
 * Keys Forge still parses for backward compatibility but no longer acts on.
 * Surfaced once at load: a silently inert setting is exactly the hidden
 * behaviour the no-fallbacks rule forbids, and the user needs to know their
 * config is asking for something that no longer exists.
 */
function warnOnDeprecatedKeys(parsed: Record<string, unknown>): void {
  const permissions = parsed['permissions'] as Record<string, unknown> | undefined;
  const agents = permissions?.['agents'] as Record<string, unknown> | undefined;
  const exec = permissions?.['exec'] as Record<string, unknown> | undefined;
  if (agents && 'cloud_workers' in agents) {
    void vscode.window.showWarningMessage(
      'Forge: permissions.agents.cloud_workers is deprecated and has no effect — ' +
        'worker dispatch was removed. You can delete it from config.yaml.',
    );
  }
  if (exec && 'shell_scripts' in exec) {
    void vscode.window.showWarningMessage(
      'Forge: permissions.exec.shell_scripts is deprecated and has no effect — shell scripts are no longer separately gated. You can delete it from config.yaml.',
    );
  }
}
