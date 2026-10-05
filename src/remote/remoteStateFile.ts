/**
 * Atomic replacement of the shared remote-state document.
 *
 * Temp file plus rename, with one Windows-specific concession: a rename over a
 * file another process has open for reading fails with EPERM there, and since
 * every window watches this file for arriving workspace handoffs, that overlap
 * is now ordinary rather than exotic. The retry is short and bounded — a real
 * permission problem still surfaces, it just takes a few milliseconds longer.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

/**
 * Whether an errno means "someone else is in this file right now", for both
 * the lock-acquisition loop and the atomic rename.
 *
 * Windows does not reserve one code for contention. A create-exclusive race on
 * a lock file, and a rename over a file another process has open for reading,
 * both surface as EPERM; EBUSY and EACCES appear too. Treating only EEXIST as
 * contention (which is what the lock loop used to do) turned an ordinary
 * overlap into a raw EPERM thrown out of a store write — while the rename
 * helper a few lines below already retried this exact set. One predicate, so
 * the two cannot drift apart again.
 *
 * `EEXIST` is contention for `open(path, 'wx')` and is also safe to retry for a
 * rename, where it means the target appeared between attempts.
 *
 * A genuine permission problem is not hidden: it burns the bounded wait and
 * then reports the real error.
 */
const CONTENTIOUS_ERRNOS = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);

export function isLockContention(code: string | undefined): boolean {
  return CONTENTIOUS_ERRNOS.has(code ?? '');
}

export async function withRemoteStateLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const started = Date.now();
  let handle: fs.FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}:${Date.now()}\n`, 'utf8');
    } catch (err) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (!isLockContention((err as NodeJS.ErrnoException).code)) throw err;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.unlink(lockPath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw new Error(`Forge remote state lock timed out: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

export async function writeRemoteStateFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, filePath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 9 || !isLockContention(code)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  } catch (err) {
    // A temp file left behind would be indistinguishable from the ones a crash
    // leaves, and this directory is the extension's own global storage.
    await fs.unlink(temporary).catch(() => undefined);
    throw err;
  }
}
