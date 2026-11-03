import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { lookupWindowsProcess } from '../backend/sdServerOwnerRecord';

export interface MediaGpuLeaseRecord {
  pid: number;
  process_start_time: number;
  owner: string;
  gpu: number;
  started_at: string;
}

export interface MediaGpuLeaseHandle {
  /** The record this handle holds now; `transfer` replaces it and `release` compares against it. */
  readonly record: MediaGpuLeaseRecord;
  /**
   * Replace this handle's lease with the same record naming another live
   * process — the child that will outlive this window when it is force-killed.
   * Only the two identity fields change, so the wire format and every other
   * taker stay as they are. Atomic: `lease.json` carries either the old record
   * or the new one, never a partial write. Refuses, leaving the file alone,
   * when the lease is no longer this handle's.
   */
  transfer(pid: number, processStartTime: number): Promise<void>;
  release(): Promise<void>;
}

export interface MediaGpuLeaseDeps {
  leasePath?: string;
  pid?: number;
  processStartTime?: number;
  lookupProcessStartTime?: (pid: number) => Promise<number | undefined>;
  now?: () => number;
  link?: typeof fs.link;
  unlink?: typeof fs.unlink;
  rename?: typeof fs.rename;
}

const DEFAULT_LEASE_PATH = path.join(os.homedir(), '.forge', 'media-gpu', 'lease.json');

/** Acquire the shared Forge/Python lease for one configured GPU. */
export async function acquireMediaGpuLease(
  owner: string,
  gpu: number,
  deps: MediaGpuLeaseDeps = {},
): Promise<MediaGpuLeaseHandle> {
  if (!owner.trim()) throw new Error('Media GPU lease owner must not be empty.');
  if (!Number.isInteger(gpu) || gpu < 0)
    throw new Error('Media GPU lease GPU must be nonnegative.');
  const leasePath = deps.leasePath ?? DEFAULT_LEASE_PATH;
  const pid = deps.pid ?? process.pid;
  const processStartTime =
    deps.processStartTime ?? (await (deps.lookupProcessStartTime ?? lookupProcessStartTime)(pid));
  if (processStartTime === undefined) {
    throw new Error(
      `Could not determine process start time for pid ${pid}; media GPU lease refused.`,
    );
  }
  const record: MediaGpuLeaseRecord = {
    pid,
    process_start_time: processStartTime,
    owner,
    gpu,
    started_at: new Date((deps.now ?? Date.now)()).toISOString(),
  };
  await fs.mkdir(path.dirname(leasePath), { recursive: true });

  try {
    await createExclusive(leasePath, record, deps);
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
    const existing = await readLease(leasePath);
    const holderStart = await (deps.lookupProcessStartTime ?? lookupProcessStartTime)(existing.pid);
    if (holderStart !== undefined && holderStart === existing.process_start_time) {
      if (
        existing.pid === pid &&
        existing.process_start_time === processStartTime &&
        existing.owner === owner
      ) {
        process.emitWarning(
          `[Forge] Reclaiming leaked media GPU lease for ${owner} at "${leasePath}".`,
        );
        await (deps.unlink ?? fs.unlink)(leasePath);
        await createExclusive(leasePath, record, deps);
        return makeHandle(leasePath, record, deps);
      }
      throw new Error(
        `Media GPU lease (one lock for every media GPU) is held by ${existing.owner} (pid ${existing.pid}, GPU ${existing.gpu}) at "${leasePath}".`,
      );
    }
    const stalePath = path.join(
      path.dirname(leasePath),
      `lease.stale-${(deps.now ?? Date.now)()}-${randomBytes(6).toString('hex')}.json`,
    );
    try {
      await (deps.rename ?? fs.rename)(leasePath, stalePath);
    } catch (renameError) {
      if (!isErrno(renameError, 'ENOENT')) {
        throw new Error(
          `Could not atomically reclaim stale media GPU lease "${leasePath}": ${errorMessage(renameError)}`,
        );
      }
    }
    let moved: MediaGpuLeaseRecord | undefined;
    try {
      moved = await readLease(stalePath);
    } catch (readError) {
      if (!isErrno(readError, 'ENOENT')) throw readError;
    }
    if (
      moved &&
      (moved.pid !== existing.pid ||
        moved.process_start_time !== existing.process_start_time ||
        moved.started_at !== existing.started_at)
    ) {
      try {
        await (deps.link ?? fs.link)(stalePath, leasePath);
        await (deps.unlink ?? fs.unlink)(stalePath);
      } catch (restoreError) {
        if (isErrno(restoreError, 'EEXIST')) {
          throw new Error(
            `A live media GPU lease was claimed during stale-lease recovery; inspect both "${leasePath}" and "${stalePath}".`,
          );
        }
        throw restoreError;
      }
      throw new Error(
        `Media GPU lease at "${leasePath}" was claimed during stale-lease recovery; refusing to replace it.`,
      );
    }
    try {
      await createExclusive(leasePath, record, deps);
    } catch (retryError) {
      if (isErrno(retryError, 'EEXIST')) {
        throw new Error(
          `Media GPU lease was claimed during stale-lease recovery at "${leasePath}".`,
        );
      }
      throw retryError;
    }
    await pruneStaleLeases(path.dirname(leasePath));
  }

  return makeHandle(leasePath, record, deps);
}

function makeHandle(
  leasePath: string,
  initialRecord: MediaGpuLeaseRecord,
  deps: MediaGpuLeaseDeps,
): MediaGpuLeaseHandle {
  let held = initialRecord;
  let released = false;
  return {
    get record() {
      return held;
    },
    async transfer(pid: number, processStartTime: number): Promise<void> {
      if (released) {
        throw new Error(
          `Media GPU lease for ${held.owner} (pid ${held.pid}) is already released; it cannot be transferred.`,
        );
      }
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`Media GPU lease cannot transfer to pid ${pid}.`);
      }
      if (!Number.isSafeInteger(processStartTime) || processStartTime <= 0) {
        throw new Error(
          `Media GPU lease cannot transfer to process start time ${processStartTime}.`,
        );
      }
      const current = await readLease(leasePath);
      if (current.pid !== held.pid || current.process_start_time !== held.process_start_time) {
        throw new Error(
          `Could not transfer the media GPU lease: "${leasePath}" is no longer held by ` +
            `${held.owner} (pid ${held.pid}); it now names ${current.owner} (pid ${current.pid}), ` +
            'so this handle does not own it and the file was left alone.',
        );
      }
      const next: MediaGpuLeaseRecord = { ...held, pid, process_start_time: processStartTime };
      await replaceLease(leasePath, next, deps);
      held = next;
    },
    async release() {
      if (released) return;
      let current: MediaGpuLeaseRecord;
      try {
        current = await readLease(leasePath);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) {
          released = true;
          return;
        }
        // A read that fails is not a release. Marking it done here was the old
        // bug: the retry became a silent no-op and the lease leaked.
        throw error;
      }
      if (current.pid !== held.pid || current.process_start_time !== held.process_start_time) {
        released = true;
        return;
      }
      await (deps.unlink ?? fs.unlink)(leasePath);
      released = true;
    },
  };
}

/** Read and validate the cross-language lease wire format. */
async function createExclusive(
  leasePath: string,
  record: MediaGpuLeaseRecord,
  deps: MediaGpuLeaseDeps,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(leasePath),
    `lease.${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  const handle = await fs.open(tempPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await (deps.link ?? fs.link)(tempPath, leasePath);
  } finally {
    try {
      await handle.close();
    } finally {
      await (deps.unlink ?? fs.unlink)(tempPath).catch((error: unknown) => {
        if (!isErrno(error, 'ENOENT')) throw error;
      });
    }
  }
}

/**
 * Replace an existing lease file with `record` atomically: the same complete
 * temp file `createExclusive` writes, then renamed over the lease. A reader —
 * the Python media taker, or another Forge window — may hold `lease.json` open,
 * which on Windows answers `EPERM`/`EBUSY`, so the rename is retried a few
 * times. A failure leaves the old record in place and no temp file behind.
 */
async function replaceLease(
  leasePath: string,
  record: MediaGpuLeaseRecord,
  deps: MediaGpuLeaseDeps,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(leasePath),
    `lease.${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    await writeLeaseTemp(tempPath, record);
    await renameOver(tempPath, leasePath, deps);
  } finally {
    await (deps.unlink ?? fs.unlink)(tempPath).catch((error: unknown) => {
      if (!isErrno(error, 'ENOENT')) throw error;
    });
  }
}

const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 25;

/** Writes the whole record and flushes it; the close must land before the rename. */
async function writeLeaseTemp(tempPath: string, record: MediaGpuLeaseRecord): Promise<void> {
  const handle = await fs.open(tempPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    // Our own handle holding the temp file open is a sharing violation on
    // Windows, so unlike `createExclusive`'s link this rename cannot overlap it.
    await handle.close();
  }
}

async function renameOver(from: string, to: string, deps: MediaGpuLeaseDeps): Promise<void> {
  const renameImpl = deps.rename ?? fs.rename;
  for (let attempt = 1; ; attempt++) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      if (!isErrno(error, 'EPERM') && !isErrno(error, 'EBUSY')) throw error;
      if (attempt >= RENAME_ATTEMPTS) {
        throw new Error(
          `Could not replace media GPU lease "${to}" after ${attempt} rename attempts: ` +
            `${errorMessage(error)}. Another reader may still have the file open.`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * attempt));
    }
  }
}

async function pruneStaleLeases(directory: string): Promise<void> {
  const stale = (await fs.readdir(directory))
    .filter((name) => /^lease\.stale-.*\.json$/.test(name))
    .sort()
    .reverse();
  for (const name of stale.slice(5)) await fs.unlink(path.join(directory, name));
}

async function readLease(leasePath: string): Promise<MediaGpuLeaseRecord> {
  let raw: string;
  try {
    raw = await fs.readFile(leasePath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw error;
    throw new Error(`Could not read media GPU lease "${leasePath}": ${errorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Malformed media GPU lease JSON at "${leasePath}"; inspect it manually.`);
  }
  if (!isLeaseRecord(parsed)) {
    throw new Error(`Malformed media GPU lease at "${leasePath}"; inspect it manually.`);
  }
  return parsed;
}

function isLeaseRecord(value: unknown): value is MediaGpuLeaseRecord {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(row['pid']) &&
    (row['pid'] as number) > 0 &&
    Number.isSafeInteger(row['process_start_time']) &&
    (row['process_start_time'] as number) > 0 &&
    typeof row['owner'] === 'string' &&
    row['owner'].length > 0 &&
    Number.isSafeInteger(row['gpu']) &&
    (row['gpu'] as number) >= 0 &&
    typeof row['started_at'] === 'string' &&
    !Number.isNaN(Date.parse(row['started_at']))
  );
}

async function lookupProcessStartTime(pid: number): Promise<number | undefined> {
  if (process.platform !== 'win32') {
    throw new Error('Media GPU process identity currently requires Windows Get-CimInstance.');
  }
  return (await lookupWindowsProcess(pid))?.createdAt;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
