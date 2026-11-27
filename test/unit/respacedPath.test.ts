import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { respacedExistingDir } from '../../src/util/respacedPath';

/**
 * A temp tree holding `vs code apps/Forge`, the shape every real slip had: the
 * model writes `vs code/apps/Forge` and the folder that exists has a space.
 */
function withTree(body: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-respaced-'));
  fs.mkdirSync(path.join(root, 'vs code apps', 'Forge'), { recursive: true });
  fs.writeFileSync(path.join(root, 'file name.txt'), '');
  try {
    body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('respacedExistingDir', () => {
  it('joins two segments when the separator stands for a space', () => {
    withTree((root) => {
      expect(respacedExistingDir(`${root}/vs code/apps/Forge`)).toBe(
        path.join(root, 'vs code apps', 'Forge'),
      );
    });
  });

  it('joins three segments when one separator stands for a space', () => {
    withTree((root) => {
      expect(respacedExistingDir(`${root}/vs/code/apps/Forge`)).toBe(
        path.join(root, 'vs code apps', 'Forge'),
      );
    });
  });

  it('returns undefined when nothing along the way exists', () => {
    withTree((root) => {
      expect(respacedExistingDir(`${root}/nothing/here`)).toBeUndefined();
    });
  });

  it('returns undefined for a path that already exists', () => {
    withTree((root) => {
      const real = path.join(root, 'vs code apps', 'Forge');
      expect(respacedExistingDir(real)).toBeUndefined();
      expect(respacedExistingDir(`${real}/`)).toBeUndefined();
    });
  });

  it('returns undefined when the respaced form is a file, not a folder', () => {
    withTree((root) => {
      expect(respacedExistingDir(`${root}/file/name.txt`)).toBeUndefined();
    });
  });

  it('leaves a relative path alone', () => {
    expect(respacedExistingDir('vs code/apps/Forge')).toBeUndefined();
  });
});
