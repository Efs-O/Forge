import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface ExpectedFileState {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface AtomicWriteOptions {
  /** Refuse the replace if the target no longer matches this stat (edit tools). */
  expected?: ExpectedFileState;
  /** Permission bits for the new file, e.g. 0o600 for tokens; POSIX only. */
  mode?: number;
}

function fileState(stat: fs.Stats): ExpectedFileState {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function assertUnchanged(target: string, expected: ExpectedFileState): void {
  const current = fileState(fs.statSync(target));
  if (
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.ctimeMs !== expected.ctimeMs
  ) {
    throw new Error(`File changed while Forge was writing it: ${target}`);
  }
}

/** An unguessable sibling, created with `wx`, so a link planted at a
 *  predictable name cannot redirect the write. */
function temporaryPathFor(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.forge-${randomUUID()}.tmp`);
}

/**
 * Write `content` to a new file and flush it to disk through the same
 * writable handle. Windows' FlushFileBuffers needs write access: an fsync on a
 * handle reopened read-only fails with EPERM, and swallowing that left every
 * write unflushed — after a power loss NTFS kept the renamed file's size but
 * not its data, and an open conversation came back as all NUL bytes.
 */
function writeAndSync(file: string, content: string | Buffer, mode: number | undefined): void {
  const handle = fs.openSync(file, 'wx', mode);
  try {
    fs.writeFileSync(handle, content);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

async function writeAndSyncAsync(
  file: string,
  content: string | Buffer,
  mode: number | undefined,
): Promise<void> {
  const handle = await fs.promises.open(file, 'wx', mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** POSIX: flush the directory entry the rename created. Windows has no equivalent. */
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const handle = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Error codes a Windows rename over a file another handle still has open can
 * raise transiently (the writer's own reader, an indexer, antivirus). On
 * Linux/macOS rename is unconditional, so these are retried everywhere but only
 * ever fire on Windows.
 */
const CONTENDED = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Is this errno one of the transient rename-contention codes this module retries? */
function isContended(error: unknown): boolean {
  return CONTENDED.has((error as NodeJS.ErrnoException).code ?? '');
}

/**
 * The error a spent rename budget surfaces, instead of the bare errno.
 *
 * `EPERM: operation not permitted, rename '…'` names nothing the agent can act
 * on, so one session retried the same dead name under four different file names
 * and burned four calls before it asked the user. The message says what is
 * blocking it, that the budget is already spent, and what to do instead — and
 * keeps `code` set, because callers branch on it (`mediaGpuLease.ts`,
 * `remoteStateFile.ts`) rather than on the text.
 */
function contentionGiveUpError(target: string, cause: unknown): Error {
  const errno = cause as NodeJS.ErrnoException;
  const code = errno.code ?? 'EPERM';
  // The errno's own sentence stays at the front, because `AtomicWrite.test.ts` and
  // any caller that matches on the text expect `operation not permitted` to be
  // there, and an agent that read only the guidance would lose what the OS said.
  const original = errno.message ?? `${code}: operation not permitted`;
  const error = new Error(
    `${original} — rename onto ${target} was retried for ${RENAME_BUDGET_MS} ms and gave up. ` +
      'Most likely another process — an editor, a watcher, a running script or antivirus — still ' +
      'holds that file open, so retrying it, or writing under another name in the same folder, ' +
      'will likely fail the same way; EACCES can also be a read-only file or an ACL. Tell the ' +
      'user which file you wanted to change and what the change was. The destination is unchanged.',
  ) as NodeJS.ErrnoException;
  error.code = code;
  error.path = target;
  return error;
}
/** Maximum time spent retrying a contended rename. */
export const RENAME_BUDGET_MS = 2_500;
const RENAME_BASE_BACKOFF_MS = 25;
const RENAME_MAX_BACKOFF_MS = 250;

/**
 * Told when a rename had to wait for another process. This module stays free
 * of `vscode`, so the extension wires the listener to its log at activation.
 * The Output log then shows whether contention stalls the host in practice,
 * which decides whether an async write is worth it.
 */
let contentionListener: ((message: string) => void) | undefined;

export function setRenameContentionListener(
  listener: ((message: string) => void) | undefined,
): void {
  contentionListener = listener;
}

/**
 * Synchronous sleep. `writeFileAtomicSync` is sync, so a Promise/setTimeout
 * backoff is unavailable; `Atomics.wait` blocks the current thread for the
 * given milliseconds without spinning.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The retry policy both rename loops share: the delay before the next attempt,
 * or undefined when `error` must be surfaced (not contention, or the budget is
 * spent). A genuine permission problem is never swallowed.
 */
function retryDelay(
  error: unknown,
  target: string,
  elapsed: number,
  attempt: number,
): number | undefined {
  if (!CONTENDED.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
  if (elapsed >= RENAME_BUDGET_MS) {
    contentionListener?.(
      `[atomicWrite] rename onto ${target} still blocked after ${elapsed} ms (${attempt} retries); giving up`,
    );
    return undefined;
  }
  return Math.min(
    RENAME_MAX_BACKOFF_MS,
    RENAME_BASE_BACKOFF_MS * 2 ** attempt,
    RENAME_BUDGET_MS - elapsed,
  );
}

function reportContended(target: string, elapsed: number, attempt: number): void {
  if (attempt > 0)
    contentionListener?.(
      `[atomicWrite] rename onto ${target} was blocked for ${elapsed} ms (${attempt} retries) before it succeeded`,
    );
}

/**
 * Rename `temporary` over `target`, retrying the transient Windows
 * EPERM/EBUSY/EACCES a concurrent reader raises while it briefly still has the
 * destination open. The synchronous sleep blocks the extension host only
 * while the OS reports transient rename contention. `rename` is injectable so
 * the retry can be tested without holding a real file open across processes.
 */
export function renameContendedSync(
  temporary: string,
  target: string,
  rename: (from: string, to: string) => void = fs.renameSync,
  now: () => number = Date.now,
  sleep: (ms: number) => void = sleepSync,
): void {
  const startedAt = now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(temporary, target);
      reportContended(target, now() - startedAt, attempt);
      return;
    } catch (error) {
      const delay = retryDelay(error, target, now() - startedAt, attempt);
      if (delay === undefined)
        throw isContended(error) ? contentionGiveUpError(target, error) : error;
      sleep(delay);
    }
  }
}

/** {@link renameContendedSync} without blocking the host between attempts.
 *  Each attempt is still `renameSync`: Node's async rename on Windows raises
 *  a transient EPERM against a concurrent reader that the sync call does not. */
async function renameContended(temporary: string, target: string): Promise<void> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporary, target);
      reportContended(target, Date.now() - startedAt, attempt);
      return;
    } catch (error) {
      const delay = retryDelay(error, target, Date.now() - startedAt, attempt);
      if (delay === undefined)
        throw isContended(error) ? contentionGiveUpError(target, error) : error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Removes the temp file after a failed write, keeping the write's own error. */
function discardTemporary(temporary: string): void {
  try {
    fs.rmSync(temporary, { force: true });
  } catch {
    // Preserve the original write error; cleanup failure is non-destructive.
  }
}

/** Replace one regular file without exposing a truncate-then-write window.
 *  The one write path for any file that must survive a crash or power loss. */
export function writeFileAtomicSync(
  target: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  const temporary = temporaryPathFor(target);
  try {
    writeAndSync(temporary, content, options.mode);
    if (options.expected) assertUnchanged(target, options.expected);
    renameContendedSync(temporary, target);
    syncDirectory(path.dirname(target));
  } catch (error) {
    discardTemporary(temporary);
    throw error;
  }
}

/** {@link writeFileAtomicSync} for async callers; it never blocks the host. */
export async function writeFileAtomic(
  target: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const temporary = temporaryPathFor(target);
  try {
    await writeAndSyncAsync(temporary, content, options.mode);
    if (options.expected) assertUnchanged(target, options.expected);
    await renameContended(temporary, target);
    syncDirectory(path.dirname(target));
  } catch (error) {
    discardTemporary(temporary);
    throw error;
  }
}
