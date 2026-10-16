import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  RENAME_BUDGET_MS,
  renameContendedSync,
  setRenameContentionListener,
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

  it('flushes through the writable handle it wrote with', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-'));
    roots.push(root);
    const target = path.join(root, 'value.txt');
    const opened = new Map<number, string>();
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      const fd = realOpen(file, flags, mode);
      opened.set(fd, String(flags));
      return fd;
    });
    const synced: number[] = [];
    const realSync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      synced.push(fd);
      realSync(fd);
    });

    writeFileAtomicSync(target, 'durable');

    // A read-only handle makes Windows' FlushFileBuffers fail with EPERM.
    expect(synced.length).toBeGreaterThan(0);
    expect(opened.get(synced[0])).toBe('w');
    expect(fs.readFileSync(target, 'utf8')).toBe('durable');
  });

  it('surfaces a flush failure and leaves the target untouched', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-'));
    roots.push(root);
    const target = path.join(root, 'value.txt');
    fs.writeFileSync(target, 'before');
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw errno('EPERM', 'fsync: operation not permitted');
    });

    expect(() => writeFileAtomicSync(target, 'after')).toThrow(/operation not permitted/);
    expect(fs.readFileSync(target, 'utf8')).toBe('before');
    expect(fs.readdirSync(root)).toEqual(['value.txt']);
  });
});

describe('renameContendedSync', () => {
  let warn: Mock<(message: string) => void>;
  beforeEach(() => {
    warn = vi.fn<(message: string) => void>();
    setRenameContentionListener(warn);
  });
  afterEach(() => {
    setRenameContentionListener(undefined);
  });

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
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /was blocked for \d+ ms \(2 retries\) before it succeeded/,
    );
  });

  it('logs nothing when the first rename succeeds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-'));
    roots.push(root);
    const temporary = path.join(root, 'tmp');
    const target = path.join(root, 'target');
    fs.writeFileSync(temporary, 'new content');

    renameContendedSync(temporary, target);

    expect(warn).not.toHaveBeenCalled();
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

  it('surfaces the last EPERM after exhausting the time budget', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-'));
    roots.push(root);
    const temporary = path.join(root, 'tmp');
    const target = path.join(root, 'target');
    fs.writeFileSync(temporary, 'new content');

    let attempts = 0;
    let now = 0;
    const sleeps: number[] = [];
    const always = () => {
      attempts += 1;
      throw errno('EPERM', 'rename: operation not permitted');
    };

    expect(() =>
      renameContendedSync(
        temporary,
        target,
        always,
        () => now,
        (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      ),
    ).toThrow(/operation not permitted/);
    expect(now).toBe(RENAME_BUDGET_MS);
    expect(attempts).toBe(sleeps.length + 1);
    expect(attempts).toBeGreaterThan(6);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(250);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(`still blocked after ${RENAME_BUDGET_MS} ms`);
    expect(warn.mock.calls[0]![0]).toMatch(/\(\d+ retries\); giving up$/);
  });
});
