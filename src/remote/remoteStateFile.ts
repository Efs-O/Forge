/**
 * Lock and atomic replacement of the shared remote-state document.
 *
 * Every window watches this file for arriving workspace handoffs, so a rename
 * over it while another process reads it (EPERM on Windows) is ordinary; the
 * shared atomic writer retries that briefly and still surfaces a real
 * permission problem.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { writeFileAtomic } from '../util/atomicWrite';

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

/**
 * Whether an errno means "someone else holds this lock right now".
 *
 * Windows does not reserve one code for contention. A create-exclusive race on
 * a lock file surfaces as EPERM; EBUSY and EACCES appear too. Treating only
 * EEXIST as contention (which is what the lock loop used to do) turned an
 * ordinary overlap into a raw EPERM thrown out of a store write.
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
  await writeFileAtomic(filePath, contents, { mode: 0o600 });
}
