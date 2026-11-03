/**
 * Path helpers shared by the skill loader and `load_skill`.
 *
 * One owner for "is this resolved path inside that resolved folder", because the
 * answer is what makes a symlink safe or unsafe, and two spellings of it in the
 * same feature is how one half drifts from the other.
 */
import * as path from 'path';

/** Case-insensitive equality on Windows, exact elsewhere. */
export function sameRealPath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
}

/**
 * True when `child` (already resolved) sits below `parent` (already resolved).
 * Equal paths count as inside: a folder's own files belong to it.
 */
export function isInsideRealPath(parent: string, child: string): boolean {
  if (sameRealPath(parent, child)) return true;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative !== '' &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.startsWith(`..${path.sep}`)
  );
}
