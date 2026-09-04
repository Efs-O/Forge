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

const CONTENDED = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function writeRemoteStateFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, filePath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (attempt >= 9 || !CONTENDED.has(code)) throw err;
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
