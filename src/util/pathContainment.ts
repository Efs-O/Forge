import * as path from 'path';

/**
 * Canonical containment test: is `candidate` at or below `root`?
 *
 * A leaf module with no `vscode` import on purpose — the checkpoint layer needs
 * this check and must stay loadable outside the extension host.
 *
 * The prefix test is segment-aware. Testing `relative.startsWith('..')` looks
 * equivalent but rejects any first segment that merely *begins* with two dots:
 * `<root>/..config` yields the relative path `..config` and would be reported
 * as an escape, so tools would refuse to touch a file that is plainly inside
 * the workspace. Only an exact `..`, or one followed by a separator, is a real
 * traversal.
 *
 * Both sides are resolved first so a relative or non-normalized input cannot
 * slip past the comparison. This is a lexical check: it does not follow
 * symlinks. Call it on realpath()'d values when the answer is a security
 * boundary — see `resolveRealWorkspacePath`.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
