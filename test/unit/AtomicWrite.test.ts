import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RENAME_ATTEMPTS,
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

describe('writeFileAtomicSync', () => {
  it('refuses to overwrite a file that changed after it was read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-'));
    roots.push(root);
    const target = path.join(root, 'value.txt');
    fs.writeFileSync(target, 'before');
    const stat = fs.statSync(target);
    fs.writeFileSync(target, 'user change');

    expect(() =>
      writeFileAtomicSync(target, 'agent change', {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      }),
    ).toThrow(/changed while Forge was writing/i);
    expect(fs.readFileSync(target, 'utf8')).toBe('user change');
  });

  it('retries a transient EPERM from the write path and still lands the file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-'));
    roots.push(root);
    const target = path.join(root, 'value.txt');
    const realRename = fs.renameSync;
    let attempts = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      attempts += 1;
      if (attempts === 1) throw errno('EPERM', 'rename: operation not permitted');
      realRename(from, to);
    });

    writeFileAtomicSync(target, 'new content');

    expect(attempts).toBe(2);
    expect(fs.readFileSync(target, 'utf8')).toBe('new content');
  });
});

describe('renameContendedSync', () => {
  it('retries a transient EPERM and then succeeds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-'));
    roots.push(root);
    const temporary = path.join(root, 'tmp');
    const target = path.join(root, 'target');
    fs.writeFileSync(temporary, 'new content');

    let attempts = 0;
    renameContendedSync(temporary, target, (from, to) => {
      attempts += 1;
      if (attempts <= 2) throw errno('EPERM', 'rename: operation not permitted');
      fs.renameSync(from, to);
    });

    expect(attempts).toBe(3);
    expect(fs.readFileSync(target, 'utf8')).toBe('new content');
  });

  it('surfaces a non-contended rename error immediately (no retry)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-'));
    roots.push(root);
    const temporary = path.join(root, 'tmp');
    const target = path.join(root, 'target');
    fs.writeFileSync(temporary, 'new content');

    let attempts = 0;
    const failing = () => {
      attempts += 1;
      throw errno('ENOENT', 'rename: no such file or directory');
    };

    expect(() => renameContendedSync(temporary, target, failing)).toThrow(
      /no such file or directory/,
    );
    expect(attempts).toBe(1);
  });

  it('surfaces the last EPERM after exhausting the bounded retries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-'));
    roots.push(root);
    const temporary = path.join(root, 'tmp');
    const target = path.join(root, 'target');
    fs.writeFileSync(temporary, 'new content');

    let attempts = 0;
    const always = () => {
      attempts += 1;
      throw errno('EPERM', 'rename: operation not permitted');
    };

    expect(() => renameContendedSync(temporary, target, always)).toThrow(
      /operation not permitted/,
    );
    expect(attempts).toBe(RENAME_ATTEMPTS);
  });
});
