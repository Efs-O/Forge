import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquire,
  lockPath,
  MAX_AGE_MS,
  readLock,
  release,
  skipReason,
  staleReason,
  tryAcquire,
} from '../../scripts/ci-lock.mjs';

let dir: string;
let path: string;

function record(token: string, pid = process.pid) {
  return { pid, childPid: null, token, cwd: 'N:/x', command: 'npm run ci:steps', started: new Date().toISOString() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-lock-test-'));
  path = join(dir, 'forge-ci.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ci-lock', () => {
  it('lets one run in and makes the second wait until the first releases', async () => {
    expect(tryAcquire(path, record('a'))).toBeNull();
    expect(tryAcquire(path, record('b'))).toMatchObject({ token: 'a' });

    const logs: string[] = [];
    let polls = 0;
    const held = await acquire(path, record('b'), {
      log: (line: string) => logs.push(line),
      sleep: async () => {
        polls += 1;
        if (polls === 2) release(path, 'a');
      },
    });
    expect(held).toBe(true);
    expect(readLock(path)).toMatchObject({ token: 'b' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('waiting for the CI run in N:/x');
  });

  it('takes over a lock whose processes have exited, but not one held by a live process', () => {
    const now = Date.now();
    const dead = { ...record('a', 999_999), childPid: 999_998 };
    expect(staleReason(dead, { now, alive: () => false, mtimeMs: now })).toContain('have exited');
    expect(staleReason(record('a'), { now, alive: (pid: number) => pid === process.pid, mtimeMs: now })).toBeNull();
    // The child still running keeps the lock even when the wrapper died.
    expect(staleReason({ ...dead, childPid: 5 }, { now, alive: (pid: number) => pid === 5, mtimeMs: now })).toBeNull();
  });

  it('expires a lock older than the age limit and an unreadable one past the grace', () => {
    const now = Date.now();
    const old = { ...record('a'), started: new Date(now - MAX_AGE_MS - 1).toISOString() };
    expect(staleReason(old, { now, alive: () => true, mtimeMs: now })).toContain('older than');
    expect(staleReason('unreadable', { now, alive: () => true, mtimeMs: now - 1_000 })).toBeNull();
    expect(staleReason('unreadable', { now, alive: () => true, mtimeMs: now - 60_000 })).toContain('unreadable');
  });

  it('acquire replaces a stale lock and says why', async () => {
    writeFileSync(path, JSON.stringify({ ...record('old', 999_999), childPid: 999_998 }));
    const logs: string[] = [];
    const held = await acquire(path, record('new'), { log: (l: string) => logs.push(l), alive: () => false });
    expect(held).toBe(true);
    expect(readLock(path)).toMatchObject({ token: 'new' });
    expect(logs[0]).toContain('taking over a stale lock');
  });

  it('gives up after the wait limit and names the holder', async () => {
    tryAcquire(path, record('a'));
    let clock = 0;
    const logs: string[] = [];
    const held = await acquire(path, record('b'), {
      now: () => clock,
      sleep: async () => {
        clock += 60_000;
      },
      waitLimitMs: 120_000,
      log: (l: string) => logs.push(l),
      alive: () => true,
    });
    expect(held).toBe(false);
    expect(logs.at(-1)).toContain('gave up after 2 min');
    expect(readLock(path)).toMatchObject({ token: 'a' });
  });

  it('release leaves another run’s lock alone', () => {
    tryAcquire(path, record('a'));
    release(path, 'b');
    expect(existsSync(path)).toBe(true);
    release(path, 'a');
    expect(existsSync(path)).toBe(false);
  });

  it('skips the lock on GitHub Actions and in a nested run, but not for a bare CI variable', () => {
    expect(skipReason({ GITHUB_ACTIONS: 'true' })).toContain('GitHub');
    expect(skipReason({ FORGE_CI_LOCK_HELD: 'tok' })).toContain('parent');
    expect(skipReason({ CI: 'true' })).toBeNull();
    expect(lockPath({ FORGE_CI_LOCK_PATH: path })).toBe(path);
  });

  it('writes valid JSON with the run details', () => {
    tryAcquire(path, record('a'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid, token: 'a' });
  });
});
