/**
 * What ripgrep is allowed to look at, for both `find_files` and `search_code`.
 *
 * Owner of the exclusion list and of the one rule that overrides it. Split out
 * of `dirTools.ts` so the two tools' plumbing and the policy about scope are
 * not read as one thing — the policy is where every "the tool says the file
 * does not exist" bug has landed.
 */
import * as fs from 'fs';
import * as path from 'path';

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
 * 2026-09-05 `search_code "num_ctx" include=".forge/config.yaml"` answered "no
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
 * this repo, so `search_code include=".forge/config.yaml"` and
 * `find_files ".forge/config.yaml"` both answered "no matches found" about the
 * most-edited file in the workspace, and the agent fell back to reading blind
 * 100-line windows of it. Naming a file is an explicit request for that file:
 * ignore rules are for deciding what to *crawl*, not for overruling the
 * caller. Wildcard patterns keep the ignore rules, which is what stops a
 * search drowning in build output.
 */
export function namedExistingPath(glob: string, root: string): string | undefined {
  if (/[*?[\]{}!]/u.test(glob)) return undefined;
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
    args.push(...SEARCH_EXCLUDES.flatMap((glob) => ['--glob', glob]));
  }
  return args;
}

/**
 * Resolve the ripgrep root and optional glob for search_code. Relative patterns
 * remain workspace-scoped; absolute paths explicitly name an external target.
 */
export function resolveSearchCodeScope(include: string, workspaceRoot: string): SearchCodeScope {
  if (!path.isAbsolute(include)) {
    const named = namedExistingPath(include, workspaceRoot);
    return named
      ? {
          target: named,
          explicitPath: true,
          // A named FILE is the one case the exclusions must not apply to; a
          // named DIRECTORY keeps them, because that is where the noise lives.
          applyExcludes: isDirectory(path.resolve(workspaceRoot, named)),
        }
      : { target: '.', glob: include, explicitPath: false, applyExcludes: true };
  }

  const absolute = path.resolve(include);
  if (!/[*?[\]{}!]/u.test(absolute)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      throw new Error(`search_code: absolute include path does not exist: ${absolute}`);
    }
    return { target: absolute, explicitPath: true, applyExcludes: stat.isDirectory() };
  }

  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep);
  const wildcardIndex = segments.findIndex((segment) => /[*?[\]{}!]/u.test(segment));
  const target = path.join(parsed.root, ...segments.slice(0, wildcardIndex));
  // A wildcard in the first segment would otherwise hand ripgrep the whole
  // drive: `N:\*` derives the root `N:\`, and `--hidden` then crawls every
  // mapped share on the machine (audit F1, 2026-10-03). Naming one directory
  // below the root is the smallest scope that can still be a real request.
  if (target === parsed.root) {
    throw new Error(
      `search_code: absolute include globs must name a directory below the drive root, ` +
        `not the root itself: ${include} (use e.g. ${path.join(parsed.root, 'someDir', '**', '*.ts')})`,
    );
  }
  const glob = segments.slice(wildcardIndex).join('/');
  let targetStat: fs.Stats;
  try {
    targetStat = fs.statSync(target);
  } catch {
    throw new Error(`search_code: absolute include root does not exist: ${target}`);
  }
  if (!targetStat.isDirectory()) {
    throw new Error(`search_code: absolute include root is not a directory: ${target}`);
  }
  return { target, glob, explicitPath: false, applyExcludes: true };
}

/** Best-effort "is this a directory"; a stat failure is treated as "not one". */
function isDirectory(absolute: string): boolean {
  try {
    return fs.statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}
