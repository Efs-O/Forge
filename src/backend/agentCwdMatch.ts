/**
 * Which Forge window an unlinked sender belongs to. Split out of
 * `agentRoutes.ts`: the router answers requests, while this is the server-side
 * half of `forge.sh`'s window choice — a comparison of two paths, with no HTTP,
 * no dependency object and no failure to report.
 */
import * as path from 'path';
import { isPathInside } from '../util/pathContainment';
import { realOrSelf } from '../util/realPath';

/**
 * How closely this window's workspace contains the sender's folder: its
 * root's length, or 0. forge.sh sends an unlinked session to the window with
 * the longest match before falling back to the focused one, so a new chat
 * opens in the sender's repo, not whichever window was clicked last.
 * Compared as written and resolved: a shell reports its folder through
 * symlinks resolved (macOS `/var` is `/private/var`), the workspace may not.
 */
export function cwdMatch(root: string | undefined, cwd: string | null): number {
  if (!cwd || !root || !path.isAbsolute(cwd)) return 0;
  const inside = isPathInside(root, cwd) || isPathInside(realOrSelf(root), realOrSelf(cwd));
  return inside ? path.resolve(root).length : 0;
}
