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
    fs.renameSync(temporary, target);
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
