import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASYNC_RENAME_BUDGET_MS,
  RENAME_BUDGET_MS,
  agentWriteOptions,
  renameContendedSync,
  writeFileAtomic,
} from '../../src/util/atomicWrite';

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
}));

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function rootFolder(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-async-'));
  roots.push(root);
  return root;
}

function firstRenameSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function useFakeAsyncFileHandle(): void {
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    const filePath = typeof file === 'string' ? file : file.toString();
    const descriptor = fs.openSync(filePath, flags, mode);
    return {
      writeFile: async (content: string | Buffer) => fs.writeFileSync(descriptor, content),
      sync: async () => fs.fsyncSync(descriptor),
      close: async () => fs.closeSync(descriptor),
    } as never;
  });
}

describe('writeFileAtomic async contention', () => {
  it('keeps the 30-second agent retry policy in one options helper', () => {
    const controller = new AbortController();
    const expected = { size: 5, mtimeMs: 1, ctimeMs: 2 };
    expect(agentWriteOptions(controller.signal, { expected, mode: 0o600 })).toEqual({
      expected,
      mode: 0o600,
      signal: controller.signal,
      retryBudgetMs: ASYNC_RENAME_BUDGET_MS,
    });
  });

  it('retries EPERM, EBUSY and EACCES with a fresh temporary name per attempt', async () => {
    vi.useFakeTimers();
    useFakeAsyncFileHandle();
    const root = rootFolder();
    const target = path.join(root, 'value.txt');
    fs.writeFileSync(target, 'before');
    const realRename = fs.renameSync;
    const firstRename = firstRenameSignal();
    const temporaryNames: string[] = [];
    const codes = ['EPERM', 'EBUSY', 'EACCES'];
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      const temporary = String(from);
      temporaryNames.push(temporary);
      firstRename.resolve();
      if (temporaryNames.length > 1) {
        expect(fs.existsSync(temporaryNames[temporaryNames.length - 2]!)).toBe(false);
      }
      const code = codes[temporaryNames.length - 1];
      if (code) throw errno(code, `rename: ${code}`);
      return realRename(from, to);
    });

    const pending = writeFileAtomic(target, 'after', { retryBudgetMs: ASYNC_RENAME_BUDGET_MS });
    await firstRename.promise;
    await vi.runAllTimersAsync();
    await pending;

    expect(temporaryNames).toHaveLength(codes.length + 1);
    expect(new Set(temporaryNames).size).toBe(temporaryNames.length);
    expect(fs.readFileSync(target, 'utf8')).toBe('after');
    expect(fs.readdirSync(root).filter((name) => name.includes('.forge-'))).toEqual([]);
  });

  it('gives up at 30 seconds with clear advice and removes the temp file', async () => {
    vi.useFakeTimers();
    useFakeAsyncFileHandle();
    vi.setSystemTime(0);
    const root = rootFolder();
    const target = path.join(root, 'locked.txt');
    fs.writeFileSync(target, 'before');
    const firstRename = firstRenameSignal();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      firstRename.resolve();
      throw errno('EPERM', 'rename: operation not permitted');
    });

    const pending = writeFileAtomic(target, 'after', { retryBudgetMs: ASYNC_RENAME_BUDGET_MS });
    const rejection = pending.catch((error: NodeJS.ErrnoException) => error);
    await firstRename.promise;
    await vi.runAllTimersAsync();
    const error = await rejection;

    const names = fs.readdirSync(root);
    expect(names).toEqual(['locked.txt']);
    expect(error).toMatchObject({ code: 'EPERM', path: target });
    expect(error.message).toContain(`${ASYNC_RENAME_BUDGET_MS} ms`);
    expect(error.message).toMatch(/wait a few seconds.*try again/i);
    expect(error.message).toMatch(/save under a new name and move it later/i);
    expect(ASYNC_RENAME_BUDGET_MS).toBe(30_000);
  });

  it('keeps full temp-file attempts below 30 during a 30-second retry window', async () => {
    vi.useFakeTimers();
    useFakeAsyncFileHandle();
    vi.setSystemTime(0);
    const root = rootFolder();
    const target = path.join(root, 'attempt-count.txt');
    fs.writeFileSync(target, 'before');
    const firstRename = firstRenameSignal();
    const attemptTimes: number[] = [];
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      attemptTimes.push(Date.now());
      firstRename.resolve();
      throw errno('EBUSY', 'rename: resource busy');
    });

    const pending = writeFileAtomic(target, 'after', {
      retryBudgetMs: ASYNC_RENAME_BUDGET_MS,
    });
    const rejection = pending.catch((error: NodeJS.ErrnoException) => error);
    await firstRename.promise;
    await vi.runAllTimersAsync();
    const error = await rejection;

    expect(error.code).toBe('EBUSY');
    expect(attemptTimes.length).toBeLessThan(30);
    // The capped final wait must lead to one last rename attempt at the budget.
    expect(attemptTimes.at(-1)).toBeGreaterThanOrEqual(ASYNC_RENAME_BUDGET_MS);
  });

  it('aborts during a pending wait immediately and leaves no temp file', async () => {
    vi.useFakeTimers();
    useFakeAsyncFileHandle();
    const root = rootFolder();
    const target = path.join(root, 'cancel.txt');
    fs.writeFileSync(target, 'before');
    const controller = new AbortController();
    const firstRename = firstRenameSignal();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      firstRename.resolve();
      setTimeout(() => controller.abort(), 5);
      throw errno('EBUSY', 'rename: resource busy');
    });

    const pending = writeFileAtomic(target, 'after', {
      signal: controller.signal,
      retryBudgetMs: ASYNC_RENAME_BUDGET_MS,
    });
    const rejection = pending.catch((error: Error) => error);
    await firstRename.promise;
    await vi.advanceTimersByTimeAsync(5);
    expect(await rejection).toMatchObject({ name: 'AbortError' });
    expect(fs.readFileSync(target, 'utf8')).toBe('before');
    expect(fs.readdirSync(root).filter((name) => name.includes('.forge-'))).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an already-aborted signal before creating a temp file', async () => {
    const root = rootFolder();
    const target = path.join(root, 'already-aborted.txt');
    fs.writeFileSync(target, 'before');
    const controller = new AbortController();
    controller.abort();
    const rename = vi.spyOn(fs, 'renameSync');

    await expect(
      writeFileAtomic(target, 'after', {
        signal: controller.signal,
        retryBudgetMs: ASYNC_RENAME_BUDGET_MS,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, 'utf8')).toBe('before');
    expect(fs.readdirSync(root)).toEqual(['already-aborted.txt']);
  });

  it('rechecks an expected destination after the wait before retrying', async () => {
    vi.useFakeTimers();
    useFakeAsyncFileHandle();
    const root = rootFolder();
    const target = path.join(root, 'changed.txt');
    fs.writeFileSync(target, 'before');
    const stat = fs.statSync(target);
    const expected = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    const firstRename = firstRenameSignal();
    let attempts = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      attempts += 1;
      firstRename.resolve();
      setTimeout(() => fs.writeFileSync(target, 'outside writer changed this'), 5);
      throw errno('EPERM', 'rename: operation not permitted');
    });

    const pending = writeFileAtomic(target, 'agent change', {
      expected,
      retryBudgetMs: ASYNC_RENAME_BUDGET_MS,
    });
    const rejection = pending.catch((error: Error) => error);
    await firstRename.promise;
    await vi.runAllTimersAsync();
    const error = await rejection;

    expect(attempts).toBe(1);
    expect(error.message).toMatch(/file changed while Forge was writing it/i);
    expect(fs.readFileSync(target, 'utf8')).toBe('outside writer changed this');
    expect(fs.readdirSync(root).filter((name) => name.includes('.forge-'))).toEqual([]);
  });

  it('keeps the synchronous retry budget at 2.5 seconds', () => {
    expect(RENAME_BUDGET_MS).toBe(2_500);
    let now = 0;
    expect(() =>
      renameContendedSync(
        'temporary',
        'target',
        () => {
          throw errno('EPERM', 'rename: operation not permitted');
        },
        () => now,
        (delay) => {
          now += delay;
        },
      ),
    ).toThrow(/operation not permitted/);
    expect(now).toBe(2_500);
  });

  it('keeps the default async retry backoff capped at 250 ms', async () => {
    vi.useFakeTimers();
    useFakeAsyncFileHandle();
    vi.setSystemTime(0);
    const root = rootFolder();
    const target = path.join(root, 'default-budget.txt');
    fs.writeFileSync(target, 'before');
    const firstRename = firstRenameSignal();
    const attemptTimes: number[] = [];
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      attemptTimes.push(Date.now());
      firstRename.resolve();
      throw errno('EPERM', 'rename: operation not permitted');
    });

    const pending = writeFileAtomic(target, 'after');
    const rejection = pending.catch((error: Error) => error);
    await firstRename.promise;
    await vi.runAllTimersAsync();
    expect((await rejection).message).toMatch(/operation not permitted/);

    expect(attemptTimes.slice(0, 6)).toEqual([0, 25, 75, 175, 375, 625]);
  });
});
