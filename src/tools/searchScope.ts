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
