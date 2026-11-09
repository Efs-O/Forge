import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultPolicyPath } from '../config/PolicyLoader';
import { realPathOfNearestAncestor } from '../util/realPath';
import { pathApiFor } from '../util/drivePath';
import { expandUserTokens, normalizePathForMatch, tokenPathCandidate } from './secretPaths';
import { nonWriteArguments } from './shellWritePositions';
import { isDirectoryChange } from './shellReadOnlyRules';
import type { RedirectTarget } from './shellCommandParse';
import type { RegisteredTool } from './ToolRegistry';

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
 * everything under `~/.forge/` is changed by the owner only, in every mode, with no
 * card and no automated answer. `config.yaml` is owner-only too, but only for as long as its
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
 * `~/.forge/` is owner-only, so it can neither create nor delete the policy file.
 *
 * What the rule does NOT reach, each one checked rather than assumed:
 * - Forge's own code, not an agent tool call: `manage_jobs` writes
 *   `~/.forge/jobs/<id>.json` (its `mutation.paths` names them), the session
 *   logger writes `~/.forge/sessions/`, the background registry writes
 *   `~/.forge/background-execs/`, and `install_llamacpp` switches one field of
 *   the config through `ConfigWriter` under its own approval card. Wrapping
 *   those would refuse a feature, not a risk, so `registerAllTools.ts` wraps
 *   the agent's file tools and leaves these three.
 * - A path the shell computes at run time (for example, `Add-Content
 *   ~/.forge/$f x`, a script, `python -c`, or command substitution). A token
 *   matcher cannot see it. `~`, `$HOME`, `%USERPROFILE%`, `$env:USERPROFILE`,
 *   Git Bash `/c/...` and `/cygdrive/c/...`, and literal same-line bash
 *   variables are expanded before matching; other run-time paths remain the
 *   same residual gap the secret gate documents in `secretPaths.ts`.
 * - A symlink that points INTO `.forge/` from elsewhere: the guard is lexical,
 *   like `pathContainment.ts`'s, because the thing it protects is the name the
 *   agent typed. `resolveRealWorkspacePath` still realpaths the write itself.
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
 * `~/.forge/` is a root in full, which is what keeps `policy.yaml` owner-only beside
 * the session logs and job records in the same folder — and it is why a `config.yaml`
 * that happens to live under `~/.forge/` is still refused: the root, not the file
 * name, is what the rule protects.
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
function resolveArgumentTarget(
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
  return root ? { supplied: supplied.trim(), target, root } : undefined;
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
 * The owner-only target a shell statement names, whole tokens only.
 *
 * Same rule as the secret gate: `git rm -f notes.config.yaml` is not a write to
 * `config.yaml`, and a substring rule would refuse every command that mentions
 * the path inside a longer name. The program token is skipped — `Add-Content` is
 * judged by its arguments, not by itself — and an `NAME=value` argument is a
 * variable assignment, not a path (`env FOO=.forge/config.yaml` changes nothing).
 * Beyond those, `nonWriteArguments` below skips the positions that hold code to
 * run or the source side of a copy, because a path there is being read.
 */
export function ownerOnlyStatementTargetFor(
  tokens: readonly string[],
  set: OwnerOnlySet,
  base?: string,
): OwnerOnlyHit | undefined {
  const positions = nonWriteArguments(tokens);
  for (const [index, token] of tokens.entries()) {
    // An inline `--target-directory=X` or `-Destination:X` names the destination,
    // and the `NAME=value` rule below would skip the whole token, so its value is
    // judged from the text `nonWriteArguments` pulled out of it.
    const forced = positions.forcedTargets.get(index);
    if (forced !== undefined) {
      const hit = ownerOnlyWriteTargetFor(forced, set, base);
      if (hit) return { ...hit, supplied: forced };
      continue;
    }
    if (index === 0 || positions.skip.has(index)) continue;
    // A bare PowerShell flag is not a destination — the T22 loop (lab 2026-11-08). But a flag can
    // *carry* its destination (`Set-Content -Path:<file>`), and `forcedTargets` only extracts
    // inline values for the copy programs (`shellWritePositions.ts`), so a colon value is judged
    // here (Claude review 2026-11-09 item 3) — only when it looks like a path: `-Encoding:utf8`
    // and `-Force:$true` are not, and resolving them against the folder put the T22 bug straight
    // back through the colon.
    if (/^-\p{L}/u.test(token)) {
      const colon = token.indexOf(':');
      if (colon === -1) continue;
      const value = token.slice(colon + 1).replace(/^["']+|["']+$/gu, '');
      if (!(/[\\/]/u.test(value) || /^(?:~|\$HOME|\$env:|[A-Za-z]:)/u.test(value))) continue;
      const forced = tokenPathCandidate(value);
      if (!forced || forced.includes('=')) continue;
      const carried = ownerOnlyWriteTargetFor(forced, set, base);
      if (carried) return { ...carried, supplied: value };
      continue;
    }
    const candidate = tokenPathCandidate(token);
    if (!candidate || candidate.includes('=')) continue;
    const hit = ownerOnlyWriteTargetFor(candidate, set, base);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The directory a statement runs in: the folder the command started in, with
 * every `cd` earlier in the same line applied on top, in order (`cd a && cd b`
 * lands in `a/b`, not in `b` read against the start).
 *
 * `undefined` when the line cannot be followed at all — a `cd` whose folder is
 * built at run time, or a relative `cd` with no folder to resolve it against.
 * That is the fail-closed side: the caller then keeps judging the write where it
 * always judged it, at the start, rather than guessing a folder the command may
 * never have reached.
 */
export function effectiveDirectoryFor(
  statements: readonly (readonly string[])[],
  index: number,
  set: OwnerOnlySet,
  base?: string,
): string | undefined {
  let current = base ?? set.workspaceRoot;
  for (let position = 0; position < index; position += 1) {
    const tokens = statements[position]!;
    if (!isDirectoryChange(tokens)) continue;
    // `$HOME`, `%USERPROFILE%` and `~` are the home folder whatever the shell
    // does with them, so they are followed; any other variable is not.
    const dir = expandUserTokens(tokens[1] ?? '', set.home);
    // The same two things `shellReadOnlyRules.ts` refuses to follow a `cd` past:
    // more than one argument, or a path built at run time.
    if (!dir || tokens.length !== 2 || /[$`()%]/u.test(dir)) return undefined;
    const moved = resolveArgumentTarget(dir, set, current);
    if (!moved) return undefined;
    current = moved;
  }
  return current;
}

/** A `>` that lands inside Forge's own files, and how it got there. */
export interface OwnerOnlyRedirect {
  /** The write target, judged from the folder the statement that holds it runs in. */
  hit: OwnerOnlyHit;
  /** The target as the command wrote it, so the refusal can name the write itself. */
  target: string;
  /** True when the write is inside Forge's own files only because a `cd` earlier in the line moved it. That distinction is the whole refusal: the `cd` is what carries a relative `>` into `~/.forge/`. */
  viaCd: boolean;
}

/**
 * The first `>` that lands inside an owner-only root, checked twice because the
 * two answers are two different facts:
 * - against the folder the command started in, which is the ordinary case and
 *   the one the guard has always judged (`echo x > .forge/config.yaml`);
 * - against the folder the `cd`s earlier in the line moved to, which is the case
 *   the guard used to refuse whole commands for. `cd ~/.forge/sessions && ls >
 *   /tmp/out.txt` writes outside Forge's files and was refused as if it wrote
 *   inside them, while `cd ~/.forge/sessions && ls > notes.txt` really does
 *   write inside them and needed a refusal that names the write, not the folder.
 *
 * The start-cwd answer wins when both hold, because that refusal does not need
 * the `cd` explained to it.
 */
export function firstOwnerOnlyRedirect(
  statements: readonly (readonly string[])[],
  redirects: readonly RedirectTarget[],
  set: OwnerOnlySet,
  base?: string,
): OwnerOnlyRedirect | undefined {
  const start = base ?? set.workspaceRoot;
  for (const redirect of redirects) {
    const atStart = ownerOnlyWriteTargetFor(redirect.target, set, start);
    if (atStart) return { hit: atStart, target: redirect.target, viaCd: false };
    if (redirect.statementIndex === 0) continue;
    const moved = effectiveDirectoryFor(statements, redirect.statementIndex, set, start);
    if (!moved || moved === normalizePathForMatch(start ?? '', set.platform)) continue;
    const afterCd = ownerOnlyWriteTargetFor(redirect.target, set, moved);
    if (afterCd) return { hit: afterCd, target: redirect.target, viaCd: true };
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
      'everything under `~/.forge/`, such as session logs and jobs — `policy.yaml` there ' +
      "is the owner's settings file, the one that says what an agent may do"
    );
  }
  return (
    'the config file Forge loads, which is owner-only while it still holds the settings ' +
    'that say what an agent may do; run "Forge: Move security settings to policy.yaml" ' +
    'to move them out, which opens this file to agents'
  );
}

/** The half of the rule the agent can still act on: reading these files is allowed, and `read_file` / `search_code` are the tools that do it. A refusal that named no way to read them would send the agent back to a shell one-liner for the same file, which is what happened in the re-run. */
const OWNER_ONLY_READS = ' Reading them with `read_file` or `search_code` is allowed.';

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

/**
 * Wraps a file-mutating tool so an owner-only target is refused in every mode,
 * before any card and before the handler runs.
 *
 * Two entry points, one implementation, both wired and both tested:
 * - `refuseBeforeApproval`, called by `ToolRegistry.invalidArgs`, which
 *   `ToolDispatch.ts` runs before it decides whether to raise a card. This is
 *   what makes the refusal card-free in normal, unattended and `/clanker` mode:
 *   a refusal from the handler alone would be a card first, because an attended
 *   `write_file` always raises one, and the user approving it would still end
 *   in a refusal.
 * - the handler, for callers that dispatch without that pre-check —
 *   `ToolRegistry.dispatch` is called directly by `benchmark/toolHost.ts`, and a
 *   guard that only lived in the pre-check would be switched off for a benchmark
 *   turn by a line elsewhere in the tree.
 *
 * Both read `tool.mutation.paths(args)` — the paths the tool itself declares it
 * will write, the same list the checkpoint snapshots and the diff renders — so a
 * wrapped tool cannot disagree with its own diff, and a tool that names several
 * paths (`delete_file`, `move_file`) is refused whole: nothing it names is
 * touched, so a refused batch cannot half-delete.
 */
export function applyOwnerOnlyWriteGuard(
  tool: RegisteredTool,
  set: () => OwnerOnlySet,
): RegisteredTool {
  const name = tool.definition.function.name;
  const hitFor = (args: Record<string, unknown>): OwnerOnlyHit | undefined => {
    const targets = tool.mutation?.paths(args) ?? [];
    for (const supplied of targets) {
      if (typeof supplied !== 'string') continue;
      const hit = ownerOnlyWriteTargetFor(supplied, set());
      if (hit) return hit;
    }
    return undefined;
  };
  const refusalFor = (args: Record<string, unknown>): string | undefined => {
    const hit = hitFor(args);
    return hit ? ownerOnlyToolRefusal(name, hit) : undefined;
  };
  return {
    ...tool,
    refuseBeforeApproval: (args, context) => {
      const refusal = refusalFor(args);
      // `invalidArgs` refusals carry the `Error:` prefix by that file's
      // convention; the handler throws the same sentence bare and
      // `toolErrorText.ts` adds it, so both paths say the same thing.
      // The wrapped tool's own pre-check runs after the wall, never instead of it.
      return refusal ? `Error: ${refusal}` : tool.refuseBeforeApproval?.(args, context);
    },
    handler: async (args, context) => {
      const hit = hitFor(args);
      if (hit) throw new Error(ownerOnlyToolRefusal(name, hit));
      return tool.handler(args, context);
    },
  };
}
