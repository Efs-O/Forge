import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { isPathInside } from '../../src/util/pathContainment';

const root = path.resolve('/ws');

describe('isPathInside', () => {
  it('accepts the root itself and anything below it', () => {
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, path.join(root, 'src', 'index.ts'))).toBe(true);
    expect(isPathInside(root, path.join(root, 'a', 'b', 'c.txt'))).toBe(true);
  });

  it('rejects real traversal out of the root', () => {
    expect(isPathInside(root, path.resolve(root, '..', 'evil'))).toBe(false);
    expect(isPathInside(root, path.resolve(root, '..'))).toBe(false);
    expect(isPathInside(root, path.resolve('/elsewhere'))).toBe(false);
  });

  it('accepts in-workspace names that merely begin with two dots', () => {
    // A `relative.startsWith('..')` test reports these as escapes, so tools
    // refuse to touch files that are plainly inside the workspace.
    expect(isPathInside(root, path.join(root, '..config'))).toBe(true);
    expect(isPathInside(root, path.join(root, '..cache', 'blob'))).toBe(true);
    expect(isPathInside(root, path.join(root, 'src', '..rc'))).toBe(true);
  });

  it('normalizes before comparing', () => {
    expect(isPathInside(root, path.join(root, 'src', '..', 'lib', 'x.ts'))).toBe(true);
    expect(isPathInside(root, path.join(root, 'src', '..', '..', 'x.ts'))).toBe(false);
  });

  it('is not confused by a sibling root sharing a name prefix', () => {
    expect(isPathInside(root, `${root}-other`)).toBe(false);
  });
});
