/**
 * The write cursor, split out of `SessionLogger.ts`: recover how many
 * conversation rows an earlier run already appended to this session file, so a
 * window reload does not re-append the whole history behind the cursor. Kept
 * apart from the writer because it reads the file backwards and the writer
 * writes it forwards, and the two must agree on one thing only: the shape of the
 * `cursor` row.
 */
import * as fs from 'fs';

/**
 * How much of the file's tail is scanned for the resume cursor. The cursor is
 * appended at the end of every flush that wrote anything, so it sits within a
 * few hundred bytes of EOF in practice; the window only has to be wider than
 * one turn's worth of trailing lines.
 */
const CURSOR_SCAN_BYTES = 1024 * 1024;

/**
 * Recover `writtenCount` from a file an earlier run left behind.
 *
 * Returns 0 when there is nothing to recover, which reproduces the old
 * behaviour (re-write the history) rather than risking the opposite error of
 * skipping messages that were never logged.
 */
export function readResumeCursor(filePath: string): number {
  let fd: number | undefined;
  try {
    const size = fs.statSync(filePath).size;
    if (size === 0) return 0;
    const start = Math.max(0, size - CURSOR_SCAN_BYTES);
    const buf = Buffer.alloc(size - start);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line || !line.includes('"cursor"')) continue;
      const parsed = JSON.parse(line) as { type?: string; written_count?: unknown };
      if (parsed.type === 'cursor' && typeof parsed.written_count === 'number') {
        return parsed.written_count;
      }
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* non-fatal */
      }
    }
  }
}
