/**
 * What ripgrep is allowed to look at, for both `find_files` and `grep_search`.
 *
 * Owner of the exclusion list and of the one rule that overrides it. Split out
 * of `dirTools.ts` so the two tools' plumbing and the policy about scope are
 * not read as one thing — the policy is where every "the tool says the file
 * does not exist" bug has landed.
 */
import * as fs from 'fs';
import * as path from 'path';

/** The one definition of a glob include, shared by search and path handling. */
export function isGlobInclude(include: string): boolean {
  return /[*?[\]{}!]/u.test(include);
}

/**
 * Globs must be recursive to match below the search root. Bare `.git/**` is
 * anchored to that root, so it excluded only a top-level `.git` and happily
 * searched `subproject/.git/`, `subproject/node_modules/`, and so on —
 * `find_files` already got this right, which is why the two tools disagreed
 * about what is in the workspace. Both now share this one list.
 *
 * `.forge/` is NOT excluded wholesale, only the three things in it that are
 * machine-written bulk: the semantic index (a verbatim copy of the sources,
 * which doubled every match — the reason the blanket exclusion was added), the
 * session logs, and the remote inbox. Excluding the whole directory also hid
 * `.forge/config.yaml`, the most-edited file in this repo, from both tools: on
 * 2026-09-05 `grep_search "num_ctx" include=".forge/config.yaml"` answered "no
 * matches found" about a file holding dozens, and the agent fell back to
 * reading 100-line windows blind. A tool that reports absence for something
 * present is worse than one that refuses.
 */
export const SEARCH_EXCLUDES = [
  '!**/.git/**',
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/out/**',
  '!**/.forge/embeddings.index.json',
  '!**/.forge/sessions/**',
  '!**/.forge/remote-inbox/**',
];

/**
 * Whether `glob` is really just a path the caller typed out in full.
 *
 * It matters because ripgrep applies `.gitignore` to anything it *discovers*
 * but not to a path handed to it as a search root. `.forge/` is gitignored in
 * this repo, so `grep_search include=".forge/config.yaml"` and
 * `find_files ".forge/config.yaml"` both answered "no matches found" about the
 * most-edited file in the workspace, and the agent fell back to reading blind
 * 100-line windows of it. Naming a file is an explicit request for that file:
 * ignore rules are for deciding what to *crawl*, not for overruling the
 * caller. Wildcard patterns keep the ignore rules, which is what stops a
 * search drowning in build output.
 */
export function namedExistingPath(glob: string, root: string): string | undefined {
  if (isGlobInclude(glob)) return undefined;
  // A leading "-" would reach ripgrep as a flag, not a path.
  if (glob.startsWith('-')) return undefined;
  const resolved = path.resolve(root, glob);
  // Never escape the workspace: a "../" path is not a search the caller can
  // have meant from a workspace-anchored glob.
  const inside = path.relative(root, resolved);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
  try {
    fs.statSync(resolved);
  } catch {
    return undefined;
  }
  // Returned workspace-relative: ripgrep runs with the workspace as its cwd,
  // and both tools report paths relative to it. Handing it an absolute path
  // would make every result in that one case absolute too.
  return inside.replace(/\\/gu, '/');
}

export interface SearchCodeScope {
  target: string;
  glob?: string;
  /** True only when the caller named a path in full: ripgrep gets `--no-ignore-vcs`. */
  explicitPath: boolean;
  /**
   * Whether `SEARCH_EXCLUDES` still applies. Only an explicitly named FILE
   * skips it — see `rgScopeArgs`.
   */
  applyExcludes: boolean;
  /**
   * The directory this search is rooted at, absolute and in forward-slash form:
   * the workspace root for `target: '.'`, otherwise the named or derived
   * directory. It is recorded because the exclusion list has to be asked against
   * it — `SEARCH_EXCLUDES` prunes `.forge/sessions/`, and a search whose ROOT is
   * that very folder came back "no matches" for text every file in it held.
   */
  rootDir: string;
}

/**
 * The exclusion globs that would prune the search root itself, split out of
 * `rgScopeArgs` because the caller has to be told about them as well as not
 * being filtered by them.
 *
 * An exclusion glob prunes a subtree; a search rooted INSIDE that subtree has
 * nothing left to search once the glob applies, and ripgrep says so by matching
 * nothing — which reads exactly like "this text is not here". Naming a folder is
 * an explicit request for that folder, the same reason `--no-ignore-vcs` is
 * handed to a named path: an ignore rule decides what to CRAWL, it does not
 * overrule what the caller asked for.
 *
 * Only an exclusion ending in `…/**` prunes a directory, so a file exclusion
 * like `!…embeddings.index.json` never covers a root and is always kept.
 */
export function exclusionsCoveringRoot(
  rootDir: string,
  platform: NodeJS.Platform = process.platform,
): { keep: string[]; dropped: string[] } {
  const fold = platform === 'win32' || platform === 'darwin';
  const rootSegments = rootDir
    .split(/[/\\]/u)
    .filter(Boolean)
    .map((part) => (fold ? part.toLowerCase() : part));
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const glob of SEARCH_EXCLUDES) {
    const pattern = glob.startsWith('!') ? glob.slice(1) : glob;
    if (!pattern.endsWith('/**')) {
      keep.push(glob);
      continue;
    }
    const run = pattern
      .slice(0, -3)
      .split('/')
      .filter((part) => part !== '**')
      .map((part) => (fold ? part.toLowerCase() : part));
    if (run.length === 0 || containsRun(rootSegments, run)) dropped.push(glob);
    else keep.push(glob);
  }
  return { keep, dropped };
}

/** Does `haystack` contain `needle` as a contiguous run of path segments? */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * The ripgrep scope arguments for a resolved search. Split out because the
 * `--no-ignore-vcs` decision and the exclusion decision are NOT the same
 * decision, and conflating them is what let a named directory crawl
 * `node_modules/` (audit F1, 2026-10-03).
 *
 * `--no-ignore-vcs` answers "the caller named this, so `.gitignore` must not
 * hide it". That argument is about *ignore files*, and it belongs to every
 * named path, file or directory. `SEARCH_EXCLUDES` answers "noise directories
 * are not what a search is for", and it belongs to everything EXCEPT a single
 * named file: naming `dist/bundle.js` in full is an explicit request for that
 * file, and an exclusion glob would filter out the one file the caller asked
 * for. A named *directory* keeps the exclusions, because a directory is where
 * the noise lives.
 */
export function rgScopeArgs(scope: SearchCodeScope): string[] {
  const args: string[] = [];
  if (scope.explicitPath) args.push('--no-ignore-vcs');
  // `scope.glob` is set exactly when the include was a pattern rather than a
  // named path. A named path needs no glob: the path IS the search root, and
  // `--glob <that path>` is matched against the paths *below* the root, so it
  // would filter out every one of them.
  if (scope.glob) args.push('--glob', scope.glob);
  if (scope.applyExcludes) {
    // The exclusions that prune the search root itself are dropped rather than
    // applied — `exclusionsCoveringRoot` says which, and `searchCodeTool.ts`
    // reports them, so a search that skipped a rule is never a silent one.
    args.push(...exclusionsCoveringRoot(scope.rootDir).keep.flatMap((glob) => ['--glob', glob]));
  }
  return args;
}

/** Build the shared scope for an existing named path (file or directory). */
export function namedPathScope(named: string, workspaceRoot: string): SearchCodeScope {
  const absolute = path.resolve(workspaceRoot, named);
  return {
    target: named,
    explicitPath: true,
    applyExcludes: isDirectory(absolute),
    rootDir: absolute.replace(/\\/gu, '/'),
  };
}

/**
 * Resolve the ripgrep root and optional glob for grep_search. Relative patterns
 * remain workspace-scoped; absolute paths explicitly name an external target.
 */
export function resolveSearchCodeScope(include: string, workspaceRoot: string): SearchCodeScope {
  const forward = (value: string): string => value.replace(/\\/gu, '/');
  if (!path.isAbsolute(include)) {
    const named = namedExistingPath(include, workspaceRoot);
    return named
      ? namedPathScope(named, workspaceRoot)
      : {
          target: '.',
          glob: include,
          explicitPath: false,
          applyExcludes: true,
          rootDir: forward(path.resolve(workspaceRoot)),
        };
  }

  const absolute = path.resolve(include);
  if (!isGlobInclude(absolute)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      throw new Error(`grep_search: absolute include path does not exist: ${absolute}`);
    }
    return {
      target: absolute,
      explicitPath: true,
      applyExcludes: stat.isDirectory(),
      rootDir: forward(stat.isDirectory() ? absolute : path.dirname(absolute)),
    };
  }

  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep);
  const wildcardIndex = segments.findIndex(isGlobInclude);
  const target = path.join(parsed.root, ...segments.slice(0, wildcardIndex));
  // A wildcard in the first segment would otherwise hand ripgrep the whole
  // drive: `N:\*` derives the root `N:\`, and `--hidden` then crawls every
  // mapped share on the machine (audit F1, 2026-10-03). Naming one directory
  // below the root is the smallest scope that can still be a real request.
  if (target === parsed.root) {
    throw new Error(
      `grep_search: absolute include globs must name a directory below the drive root, ` +
        `not the root itself: ${include} (use e.g. ${path.join(parsed.root, 'someDir', '**', '*.ts')})`,
    );
  }
  const glob = segments.slice(wildcardIndex).join('/');
  let targetStat: fs.Stats;
  try {
    targetStat = fs.statSync(target);
  } catch {
    throw new Error(`grep_search: absolute include root does not exist: ${target}`);
  }
  if (!targetStat.isDirectory()) {
    throw new Error(`grep_search: absolute include root is not a directory: ${target}`);
  }
  return {
    target,
    glob,
    explicitPath: false,
    applyExcludes: true,
    rootDir: forward(target),
  };
}

/** Best-effort "is this a directory"; a stat failure is treated as "not one". */
function isDirectory(absolute: string): boolean {
  try {
    return fs.statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}
