import * as crypto from 'crypto';
import * as fs from 'fs';
import type { InventoryEntry } from './CheckpointInventory';

export const FREE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;
const IO_BUFFER_BYTES = 64 * 1024;

export function throwIfCheckpointAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Checkpoint preparation cancelled');
}

export function formatCheckpointBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export async function writeCheckpointJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(temporary, target);
  } catch (err) {
    await fs.promises.rm(temporary, { force: true });
    throw err;
  }
}

export async function readAndHashCheckpointFile(
  sourcePath: string,
  destinationPath: string | undefined,
  expected: Extract<InventoryEntry, { kind: 'file' }>,
  signal: AbortSignal,
): Promise<string> {
  const before = await fs.promises.lstat(sourcePath);
  if (!before.isFile() || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs) {
    throw new Error(`Checkpoint source changed during preparation: ${sourcePath}`);
  }
  const source = await fs.promises.open(sourcePath, 'r');
  let destination: fs.promises.FileHandle | undefined;
  try {
    destination = destinationPath ? await fs.promises.open(destinationPath, 'wx') : undefined;
  } catch (err) {
    await source.close();
    throw err;
  }
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
  let position = 0;
  try {
    while (true) {
      throwIfCheckpointAborted(signal);
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (destination) {
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(
            chunk,
            written,
            bytesRead - written,
            position + written,
          );
          if (result.bytesWritten === 0)
            throw new Error(`Checkpoint write stalled: ${destinationPath}`);
          written += result.bytesWritten;
        }
      }
      position += bytesRead;
    }
    await destination?.sync();
  } finally {
    await Promise.all([source.close(), ...(destination ? [destination.close()] : [])]);
  }
  const after = await fs.promises.lstat(sourcePath);
  if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`Checkpoint source changed while being read: ${sourcePath}`);
  }
  return hash.digest('hex');
}

export async function hashCheckpointFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(filePath, 'r');
  const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}
