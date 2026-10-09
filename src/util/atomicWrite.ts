import * as fs from 'fs';
import * as path from 'path';

let sequence = 0;

export interface ExpectedFileState {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
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

function syncFile(handle: number): void {
  try {
    fs.fsyncSync(handle);
  } catch (err) {
    // Node's Windows implementation can report EPERM for FlushFileBuffers on
    // regular files. The rename still prevents torn readers; unexpected sync
    // failures on other platforms must remain visible to the caller.
    if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') return;
    throw err;
  }
}

/**
 * Error codes a Windows rename over a file another handle still has open can
 * raise transiently (the writer's own reader, an indexer, antivirus). On
 * Linux/macOS rename is unconditional, so these are retried everywhere but only
 * ever fire on Windows.
 */
const CONTENDED = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Maximum time spent retrying a contended rename. */
export const RENAME_BUDGET_MS = 2_500;
const RENAME_BASE_BACKOFF_MS = 25;
const RENAME_MAX_BACKOFF_MS = 250;

/**
 * Synchronous sleep. `writeFileAtomicSync` is sync, so a Promise/setTimeout
 * backoff is unavailable; `Atomics.wait` blocks the current thread for the
 * given milliseconds without spinning.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename `temporary` over `target`, retrying the transient Windows
 * EPERM/EBUSY/EACCES a concurrent reader raises while it briefly still has the
 * destination open. The synchronous sleep blocks the extension host only
 * while the OS reports transient rename contention. A genuine
 * permission problem, or the last contended attempt, is surfaced — never
 * swallowed. `rename` is injectable so the retry can be tested without holding
 * a real file open across processes.
 */
export function renameContendedSync(
  temporary: string,
  target: string,
  rename: (from: string, to: string) => void = fs.renameSync,
  now: () => number = Date.now,
  sleep: (ms: number) => void = sleepSync,
): void {
  let lastError: unknown;
  const startedAt = now();
  let attempt = 0;
  while (true) {
    try {
      rename(temporary, target);
      return;
    } catch (error) {
      lastError = error;
      if (!CONTENDED.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const elapsed = now() - startedAt;
      if (elapsed >= RENAME_BUDGET_MS) break;
      const delay = Math.min(
        RENAME_MAX_BACKOFF_MS,
        RENAME_BASE_BACKOFF_MS * 2 ** attempt,
        RENAME_BUDGET_MS - elapsed,
      );
      sleep(delay);
      attempt += 1;
    }
  }
  throw lastError;
}

/** Replace one regular file without exposing a truncate-then-write window. */
export function writeFileAtomicSync(
  target: string,
  content: string | Buffer,
  expected?: ExpectedFileState,
): void {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.forge-${process.pid}-${sequence++}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content);
    const temporaryHandle = fs.openSync(temporary, 'r');
    try {
      syncFile(temporaryHandle);
    } finally {
      fs.closeSync(temporaryHandle);
    }
    if (expected) assertUnchanged(target, expected);
    renameContendedSync(temporary, target);
    if (process.platform !== 'win32') {
      const directoryHandle = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryHandle);
      } finally {
        fs.closeSync(directoryHandle);
      }
    }
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // Preserve the original write error; cleanup failure is non-destructive.
    }
    throw error;
  }
}
