import * as fs from 'fs';
import * as path from 'path';

/**
 * Real-path the nearest existing ancestor and re-append the missing tail, so a
 * target that does not exist yet — or has just been deleted — lands on the same
 * spelling the file system uses for it. On Windows `realpathSync.native` also
 * expands 8.3 short names (`EFSOOF~1`) and follows junctions and symlinks, which
 * is why the owner-only guard asks this as well as comparing text: the
 * 2026-11-02 red-team wrote `~/.forge/policy.yaml` as `C:/Users/EFSOOF~1/...`.
 *
 * Throws only for errors other than a missing path (a permission error, a
 * symlink loop); the caller decides what an uninspectable path means.
 */
export function realPathOfNearestAncestor(resolved: string): string {
  const tail: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real =
        process.platform === 'win32' ? fs.realpathSync.native(current) : fs.realpathSync(current);
      return path.join(real, ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
