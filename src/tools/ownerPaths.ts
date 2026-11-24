import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultPolicyPath } from '../config/PolicyLoader';
import { realPathOfNearestAncestor } from '../util/realPath';
import { pathApiFor } from '../util/drivePath';
import { expandUserTokens, normalizePathForMatch } from './secretPaths';
import { isOpenForgeWriteTarget } from './ownerPathsOpen';

/**
 * Which paths an agent may not change: Forge's own files.
 *
 * Why this exists (docs/reports/TODO_2026_10_28.md item 4, from the 10-28 live
 * security test): every guard Forge has — the allow lists, the approval gates,
 * the secret-path list — lived in `config.yaml`, and any agent holding a write
 * tool could edit that file and switch its own guards off. Nothing in the tree
 * treated the config specially: an unattended run auto-approved the edit, and
 * `ConfigLoader.ts` watches the file, so the new rules took effect ~150 ms later.
 * `CheckpointManifest.ts` skips `.forge/`, so Undo could not put the file back
 * either.
 *
 * The rule as of phase 3 of the policy split (`docs/plans/SECURITY_SIMPLIFICATION_PLAN.md`):
 * everything under `~/.forge/` is changed by the owner only, except memory files
 * (`~/.forge/memories/<project>/<name>.md`) and skills (`~/.forge/skills/`), in every
 * mode, with no card and no automated answer. `config.yaml` is owner-only while its
 * security settings are still inside it: once `~/.forge/policy.yaml` exists the
 * guards have moved out of `config.yaml`, the file opens to agents, and editing model
 * tuning — a `num_ctx`, a profile, a comment — is ordinary work rather than a rewrite
 * of the agent's own guards. The two files are asked apart because the answer changes
 * with them, and the question is asked again on every decision, never once per window:
 * a remembered "the policy file is there" would leave config.yaml open after the owner
 * deleted it, which is the wall coming back and not being noticed.
 *
 * Every key that could loosen a guard moved to the policy file (`policySchema.ts`),
 * and `ConfigLoader` refuses a policy key, a model-level `start_command` or an
 * unapproved `endpoint` host left behind in `config.yaml`, so opening the config to
 * agents did not reopen the guards. An agent cannot reach either state by itself:
 * the rest of `~/.forge/` is owner-only, so it can neither create nor delete the policy file.
 *
 * What the rule does NOT reach, each one checked rather than assumed:
 * - Forge's own code, not an agent tool call: `manage_jobs` writes
 *   `~/.forge/jobs/<id>.json` (its `mutation.paths` names them), the session
 *   logger writes `~/.forge/sessions/`, and the background registry writes
 *   `~/.forge/background-execs/`. Wrapping those would refuse a feature, not a
 *   risk, so `registerAllTools.ts` wraps the agent's file tools and leaves these.
 * - A path the shell computes at run time (for example, `Add-Content
 *   ~/.forge/$f x`, a script, `python -c`, or command substitution). A token
 *   matcher cannot see it. `~`, `$HOME`, `%USERPROFILE%`, `$env:USERPROFILE`,
 *   Git Bash `/c/...` and `/cygdrive/c/...`, and literal same-line bash
 *   variables are expanded before matching; other run-time paths remain the
 *   same residual gap the secret gate documents in `secretPaths.ts`.
 * - An LSP edit that reaches a policy file while acting on another file:
 *   `rename_symbol` / `format_file` / `apply_code_action` are judged by the path
 *   the call names — the same list the checkpoint snapshots and the diff renders.
 *
 * Matching happens on a normalised form shared with `secretPaths.ts`: forward
 * slashes, `~` forms expanded, `..` collapsed, and case folded only where the
 * file system is case-insensitive.
 */

/** `.forge` is Forge's own folder name; `~/.forge/` is the owner's folder. */
const FORGE_DIR = '.forge';
/** The config file each window loads, by name — a leaf is not its folder. */
const CONFIG_FILE = 'config.yaml';

/** A write target that fell inside an owner-only root. */
export interface OwnerOnlyHit {
  /** The path as the call named it — the refusal quotes this, because it is the spelling the agent typed. */
  supplied: string;
  /** The same path resolved for matching: absolute, forward slashes, case-folded where the OS is. */
  target: string;
  /** The owner-only root the target is equal to, or strictly inside. */
  root: string;
  /** Script whose later argument hit an owner-only path, if any. */
  scriptToken?: string;
}

/** What one window refuses writes onto. */
export interface OwnerOnlySet {
  readonly roots: readonly string[];
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly workspaceRoot?: string;
}

export interface OwnerOnlySetOptions {
  workspaceRoot?: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** The config file this window actually loads (`jobs.configPath`). A root only
   *  while the policy file is absent — see `ownerOnlySetFor`.
   */
  configPath?: string;
  /** `~/.forge/policy.yaml` by default. Open because the real file is machine-wide
   *  and a test must be able to say "this fixture home has one" without writing to
   *  the owner's folder. Nothing else may redirect it: an agent-set environment
   *  variable here would let the agent choose which policy file the wall reads.
   */
  policyPath?: string;
}

/**
 * The owner-only roots for one window: `~/.forge/` always, and `config.yaml` only
 * while the policy file is absent.
 *
 * `~/.forge/` remains a root, which keeps `policy.yaml` owner-only beside the
 * session logs and job records. `ownerOnlyWriteTargetFor` opens only memory files
 * and skills after matching both the supplied path and its real path.
 *
 * `config.yaml` is the half that changes. Its policy keys and its model-level server
 * programs are what an agent could rewrite to loosen its own guards, so while those
 * are still inside it the file stays owner-only. Once `~/.forge/policy.yaml` exists
 * they are not, `ConfigLoader` refuses any that come back, and the file opens: the
 * question is asked again on every call, because the caller rebuilds this set for
 * every decision and a cached answer would keep the file open after the owner
 * deleted the policy file that made opening it safe.
 */
export function ownerOnlySetFor(options: OwnerOnlySetOptions): OwnerOnlySet {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const api = pathApiFor(platform);
  const roots: string[] = [];
  const add = (value: string | undefined): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    const normalized = normalizePathForMatch(api.resolve(expandUserTokens(value, home)), platform);
    if (normalized && !roots.includes(normalized)) roots.push(normalized);
  };
  const policyPath = options.policyPath ?? defaultPolicyPath(home);
  const policyPresent = fs.existsSync(policyPath);
  add(api.join(home, FORGE_DIR));
  if (!policyPresent) {
    add(options.configPath);
    if (options.workspaceRoot) add(api.join(options.workspaceRoot, FORGE_DIR, CONFIG_FILE));
  }
  return {
    roots,
    home,
    platform,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
  };
}

/**
 * The owner-only root `candidate` is equal to, or strictly inside.
 *
 * `pathContainment.ts`'s `isPathInside` is the repo's containment owner, but it
 * is case-sensitive and resolves a relative input against `process.cwd()`; both
 * sides here are already absolute and normalised (`..` collapsed, case folded
 * where the OS is), so the segment test is this prefix — and a `config.yaml.bak`
 * leaf is not `config.yaml` with a suffix, which a bare `startsWith` would call.
 *
 * Not exported: `ownerOnlyWriteTargetFor` below is the one question the guards
 * ask, and nothing outside this file needs the raw prefix test.
 */
function matchOwnerOnlyRoot(candidate: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    if (candidate === root || candidate.startsWith(`${root}/`)) return root;
  }
  return undefined;
}

/**
 * The path this argument names, resolved for matching, or `undefined` when it
 * cannot be resolved at all. `ownerOnlyWriteTargetFor` below is this plus the
 * root question, and `effectiveDirectoryFor` needs the resolution without the
 * root question, because a `cd` into an ordinary folder still moves the
 * directory that a later `>` is judged against.
 */
export function resolveArgumentTarget(
  supplied: string,
  set: OwnerOnlySet,
  base?: string,
): string | undefined {
  if (typeof supplied !== 'string') return undefined;
  const trimmed = supplied.trim();
  if (!trimmed) return undefined;
  const api = pathApiFor(set.platform);
  const expanded = normalizePathForMatch(expandUserTokens(trimmed, set.home), set.platform);
  const fallbackBase = base ?? set.workspaceRoot;
  const absolute = api.isAbsolute(expanded)
    ? expanded
    : fallbackBase
      ? api.resolve(fallbackBase, expanded)
      : undefined;
  if (!absolute) return undefined;
  return normalizePathForMatch(api.resolve(absolute), set.platform);
}

/**
 * The owner-only target this argument names, or undefined when writing it is the
 * agent's own business.
 *
 * Resolved lexically against `base` — the workspace root for a file tool, the
 * shell tool's cwd for a command — because that is what the tool would open. A
 * relative argument with no base to resolve against cannot be judged and is
 * allowed, which is what a window with no folder open gets.
 */
export function ownerOnlyWriteTargetFor(
  supplied: string,
  set: OwnerOnlySet,
  base?: string,
): OwnerOnlyHit | undefined {
  const target = resolveArgumentTarget(supplied, set, base);
  if (!target) return undefined;
  const root = matchOwnerOnlyRoot(target, set.roots) ?? matchOwnerOnlyRootOnDisk(target, set);
  return root && !isOpenForgeWriteTarget(target, set)
    ? { supplied: supplied.trim(), target, root }
    : undefined;
}

/**
 * The same root question asked of the file system rather than the text: both
 * sides are real-pathed, so an 8.3 short name (`C:/Users/EFSOOF~1/.forge`), a
 * junction or a symlink into `~/.forge/` meets the root it really names. Only
 * when the set describes this machine — a fixture set with a made-up home is
 * judged on its text, as before.
 */
function matchOwnerOnlyRootOnDisk(target: string, set: OwnerOnlySet): string | undefined {
  if (set.platform !== process.platform) return undefined;
  const onDisk = (value: string): string | undefined => {
    try {
      let real = realPathOfNearestAncestor(path.resolve(value));
      if (real.startsWith('\\\\?\\UNC\\')) real = `\\\\${real.slice(8)}`;
      else if (real.startsWith('\\\\?\\')) real = real.slice(4);
      return normalizePathForMatch(real, set.platform);
    } catch {
      // A path the file system will not resolve (a permission error, a link
      // loop) keeps the text answer above, which has already been given.
      return undefined;
    }
  };
  const real = onDisk(target);
  if (!real) return undefined;
  for (const root of set.roots) {
    const realRoot = onDisk(root);
    if (realRoot && (real === realRoot || real.startsWith(`${realRoot}/`))) return root;
  }
  return undefined;
}

/**
 * What is owner-only, said once so every refusal means the same thing. It is
 * Forge's own FILES, not its configuration: `~/.forge/` holds session logs and
 * jobs as well as `policy.yaml`, and calling a log a setting sent the agent
 * reasoning about a file that was never the problem — it read session logs with a
 * `python -` one-liner, was refused, and believed the read itself was refused
 * (docs/reports/V1_SECURITY_LIVE_TEST.md re-run, finding 2).
 *
 * `config.yaml` is in the subject only while its security settings are still inside
 * it, which is the case `ownerOnlyRootClause` below says out loud: an agent that had
 * its config edit refused needs to know the file is closed because of what it still
 * holds, not because of its name, or it will go looking for another way in.
 */
const OWNER_ONLY_SUBJECT =
  "Forge's own files (`~/.forge/`, and `config.yaml` while its security settings are " +
  'still inside that file rather than in `~/.forge/policy.yaml`)';

/**
 * The clause that says what THIS path fell inside, so a refusal names the thing
 * the agent was trying to change rather than a generic "Forge's own files".
 *
 * Two roots, two sentences, because they are refused for two different reasons:
 * the `~/.forge/` folder holds the owner's state and `policy.yaml` — the file that
 * says what an agent may do, which the plan asks every refusal to name, since it is
 * the file an agent that has just been refused will want to ask about — while a
 * `config.yaml` root exists only until the policy split is run, and is closed for
 * exactly as long as it still holds those settings.
 */
function ownerOnlyRootClause(root: string): string {
  if (root.split('/').at(-1) === FORGE_DIR) {
    return (
      'everything under `~/.forge/` except memory files (`~/.forge/memories/<project>/<name>.md`) ' +
      'and skills (`~/.forge/skills/`); it holds session logs and jobs, and `policy.yaml` there is ' +
      "the owner's settings file, the one that says what an agent may do"
    );
  }
  return (
    'the config file Forge loads, which is owner-only while it still holds the settings ' +
    'that say what an agent may do; run "Forge: Move security settings to policy.yaml" ' +
    'to move them out, which opens this file to agents'
  );
}

/** The half of the rule the agent can still act on: reading these files is allowed, and `read_file` / `grep_search` are the tools that do it. A refusal that named no way to read them would send the agent back to a shell one-liner for the same file, which is what happened in the re-run. */
const OWNER_ONLY_READS = ' Reading them with `read_file` or `grep_search` is allowed.';

/** The tail every owner-only refusal carries: who may change it, and what to do instead of hunting for another way. It names no way to CHANGE them, because for the agent there is none — a guard that refused legitimate work would send it looking for one. */
const OWNER_ONLY_TAIL = ' Tell the user what change you want and why, and let them make it.';

/** The rule as a sentence, for a shell refusal where the rule line already named the path. */
export function ownerOnlyInstruction(): string {
  return (
    `${OWNER_ONLY_SUBJECT} are changed by the owner only, never by a tool call.` +
    `${OWNER_ONLY_READS}${OWNER_ONLY_TAIL}`
  );
}

/**
 * The same rule as a file tool's own refusal, naming the path as the call named
 * it and the root it fell inside, so the sentence describes the file in front of
 * the agent rather than the whole set.
 */
export function ownerOnlyToolRefusal(name: string, hit: OwnerOnlyHit): string {
  return (
    `${name}: ${hit.supplied} is part of Forge's own files (${ownerOnlyRootClause(hit.root)}), ` +
    `which only the owner changes.${OWNER_ONLY_READS}${OWNER_ONLY_TAIL}`
  );
}
