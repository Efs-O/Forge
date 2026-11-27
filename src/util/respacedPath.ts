import * as fs from 'fs';
import * as path from 'path';

/**
 * The folder a missing path was meant to name, when the difference is only that
 * the model wrote a separator where the real folder name has a space:
 * `N:/vs code/apps/Forge` for `N:/vs code apps/Forge`.
 *
 * Measured 2026-11-27 over 14 days of session logs: 10 refusals for a `cwd`
 * that did not exist, every one this same slip. The tips table and the tool
 * description both say the folder has a space, and the model writes the slash
 * anyway, so the tool resolves it instead of refusing.
 *
 * Walks from the root: a segment that exists is taken as it stands; otherwise
 * it is joined with the following segments, one space per join, and the first
 * join that exists is taken. Returns `undefined` when nothing along the way
 * exists, and when the answer is the input itself or not a folder — a path that
 * exists is nobody's business, and a file is not a working directory.
 */
export function respacedExistingDir(missing: string): string | undefined {
  if (!path.isAbsolute(missing)) return undefined;
  const root = path.parse(missing).root;
  const segments = missing
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) return undefined;

  let current = root;
  let index = 0;
  while (index < segments.length) {
    const direct = path.join(current, segments[index]!);
    if (fs.existsSync(direct)) {
      current = direct;
      index += 1;
      continue;
    }
    let joined = false;
    for (let take = 2; index + take <= segments.length; take++) {
      const candidate = path.join(current, segments.slice(index, index + take)!.join(' '));
      if (fs.existsSync(candidate)) {
        current = candidate;
        index += take;
        joined = true;
        break;
      }
    }
    if (!joined) return undefined;
  }

  const answer = path.normalize(current);
  // `normalize` keeps a trailing separator, so strip it before comparing: a
  // path that exists is nobody's business, whatever spelling it arrived in.
  if (answer === path.normalize(missing.replace(/[\\/]+$/u, ''))) return undefined;
  try {
    return fs.statSync(answer).isDirectory() ? answer : undefined;
  } catch {
    return undefined;
  }
}
