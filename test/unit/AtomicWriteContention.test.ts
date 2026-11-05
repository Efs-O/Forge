import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RENAME_BUDGET_MS,
  renameContendedSync,
  writeFileAtomicSync,
} from '../../src/util/atomicWrite';

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function rootFolder(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-contention-'));
  roots.push(root);
  return root;
}

describe('a rename whose contention budget is spent', () => {
  it('says what is blocking it and what to do, not only the errno', () => {
    const root = rootFolder();
    const temporary = path.join(root, 'tmp');
    const target = path.join(root, 'board_sidecar.py');
    fs.writeFileSync(temporary, 'new content');

    let now = 0;
    let caught: NodeJS.ErrnoException | undefined;
    try {
      renameContendedSync(
        temporary,
        target,
        () => {
          throw errno('EPERM', 'rename: operation not permitted');
        },
        () => now,
        (ms) => {
          now += ms;
        },
      );
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught?.code).toBe('EPERM'); // callers branch on `code`, not on the text
    expect(caught?.path).toBe(target);
    expect(caught?.message).toContain(RENAME_BUDGET_MS.toString());
    expect(caught?.message).toMatch(/gave up/);
    expect(caught?.message).toMatch(/another process/i);
    expect(caught?.message).toMatch(/most likely/i);
    expect(caught?.message).toMatch(/wait a few seconds/i);
    expect(caught?.message).toMatch(/new name and move it later/i);
    expect(caught?.message).toMatch(/close whatever has the file open/i);
    expect(caught?.message).toMatch(/tell the user/i);
    expect(caught?.message).toMatch(/destination is unchanged/);
  });

  it('leaves the raw errno for a rename error that is not contention', () => {
    const root = rootFolder();
    const temporary = path.join(root, 'tmp');
    const target = path.join(root, 'target');
    fs.writeFileSync(temporary, 'new content');

    expect(() =>
      renameContendedSync(temporary, target, () => {
        throw errno('ENOENT', 'rename: no such file or directory');
      }),
    ).toThrow(/no such file or directory/);
  });
});

describe('the temp file a failed rename leaves behind', () => {
  it('is removed, so a failed write does not litter the folder', () => {
    const root = rootFolder();
    const target = path.join(root, 'value.txt');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw errno('EEXIST', 'rename: file exists');
    });

    expect(() => writeFileAtomicSync(target, 'agent content')).toThrow(/file exists/);
    vi.restoreAllMocks();

    expect(fs.readdirSync(root).filter((name) => name.includes('.forge-'))).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });
});
