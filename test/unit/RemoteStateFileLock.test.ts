import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isLockContention,
  withRemoteStateLock,
  writeRemoteStateFile,
} from '../../src/remote/remoteStateFile';

/**
 * The shared remote-state document's lock and atomic-replacement helpers.
 *
 * The defect this file exists for: the lock loop treated only EEXIST as
 * "someone else is in this file", while Windows reports the same contention as
 * EPERM (and sometimes EBUSY/EACCES) — the very set the rename helper a few
 * lines below already retried. A contended lock therefore escaped as a raw
 * EPERM from a store write instead of waiting.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    // Retried: Windows can still hold a just-closed file (EBUSY).
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function tempFile(name = 'state.json'): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-state-lock-'));
  tempDirs.push(directory);
  return path.join(directory, name);
}

describe('isLockContention', () => {
  it('treats every Windows contention errno as retryable, not only EEXIST', () => {
    for (const code of ['EEXIST', 'EPERM', 'EBUSY', 'EACCES']) {
      expect(isLockContention(code)).toBe(true);
    }
  });

  it('does not treat an unrelated errno as contention', () => {
    for (const code of ['ENOENT', 'ENOSPC', 'ENOTDIR', 'EROFS', undefined, '']) {
      expect(isLockContention(code)).toBe(false);
    }
  });
});

describe('withRemoteStateLock', () => {
  it('serializes two acquisitions of the same lock', async () => {
    const file = await tempFile();
    // Which order two contending waiters take is *not* promised: acquisition is a
    // create-exclusive race polled every LOCK_WAIT_MS, with no queue. So this
    // asserts the invariant that does hold, order-independently: the two
    // critical sections are never live at the same time.
    let inside = 0;
    let peak = 0;
    const order: string[] = [];

    const hold = (label: string) =>
      withRemoteStateLock(file, async () => {
        order.push(`${label}:start`);
        inside += 1;
        peak = Math.max(peak, inside);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inside -= 1;
        order.push(`${label}:end`);
        return label;
      });

    const first = hold('first');
    const second = hold('second');

    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(peak).toBe(1);
    // Each ran exactly once, start paired with end.
    expect(order.filter((entry) => entry === 'first:start')).toHaveLength(1);
    expect(order.filter((entry) => entry === 'second:start')).toHaveLength(1);
    expect(order.indexOf('first:end')).toBeGreaterThan(order.indexOf('first:start'));
    expect(order.indexOf('second:end')).toBeGreaterThan(order.indexOf('second:start'));
  });

  it('releases the lock file so a later acquisition is not blocked', async () => {
    const file = await tempFile();
    await withRemoteStateLock(file, async () => undefined);
    await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(withRemoteStateLock(file, async () => 'again')).resolves.toBe('again');
  });

  it('releases the lock even when the operation throws', async () => {
    const file = await tempFile();
    await expect(
      withRemoteStateLock(file, async () => {
        throw new Error('store write failed');
      }),
    ).rejects.toThrow('store write failed');
    await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a lock left behind by a dead process instead of waiting out the timeout', async () => {
    const file = await tempFile();
    // A crash can leave the lock file; its mtime is what marks it stale.
    await fs.writeFile(`${file}.lock`, '999999:1\n', { mode: 0o600 });
    const stale = Date.now() - 120_000;
    await fs.utimes(`${file}.lock`, new Date(stale), new Date(stale));

    await expect(withRemoteStateLock(file, async () => 'took over')).resolves.toBe('took over');
  });

  it('lets a non-contention error from the open path surface rather than retrying', async () => {
    // A path whose parent is a file, not a directory: not contention, and a
    // 15 s wait would only delay the real answer.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-state-lock-'));
    tempDirs.push(directory);
    const notADirectory = path.join(directory, 'a-file');
    await fs.writeFile(notADirectory, 'x', 'utf8');

    await expect(
      withRemoteStateLock(path.join(notADirectory, 'state.json'), async () => undefined),
    ).rejects.toThrow();
  });
});

describe('writeRemoteStateFile', () => {
  it('writes atomically and leaves no temporary file behind', async () => {
    const file = await tempFile();
    await writeRemoteStateFile(file, '{"a":1}');
    expect(await fs.readFile(file, 'utf8')).toBe('{"a":1}');
    const entries = await fs.readdir(path.dirname(file));
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an existing document without losing the last write', async () => {
    const file = await tempFile();
    await writeRemoteStateFile(file, 'first');
    await writeRemoteStateFile(file, 'second');
    expect(await fs.readFile(file, 'utf8')).toBe('second');
  });

  it('retries a rename that briefly collides with a reader', async () => {
    const file = await tempFile();
    await writeRemoteStateFile(file, 'original');
    // Every window watches this file, so a reader can be open on it while a
    // writer renames over it — the overlap that fails with EPERM on Windows.
    // The bounded retry is meant for the ordinary shape of that: a reader that
    // closes. A reader that never releases still fails after the retries, and
    // that limit is pre-existing and unchanged here.
    const reader = await fs.open(file, 'r');
    const release = setTimeout(() => void reader.close(), 40);
    try {
      await writeRemoteStateFile(file, 'updated');
    } finally {
      clearTimeout(release);
      await reader.close().catch(() => undefined);
    }
    expect(await fs.readFile(file, 'utf8')).toBe('updated');
  });
});
