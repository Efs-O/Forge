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
import { reclaim, UNREADABLE_LOCK_GRACE_MS } from '../agentMesh/lock';
import { isProcessAlive } from '../util/processLiveness';
import { getLogger } from '../util/logger';
import {
  EMPTY_REMOTE_STATE,
  LegacyRemoteStateSchema,
  migrateLegacyState,
  RemoteStateSchema,
  type RemoteStoreState,
} from './RemoteStoreSchemas';

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 60_000;
const ORPHAN_TEMP_TTL_MS = 10 * 60_000;
const log = getLogger();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Run `operation` holding `<file>.lock` (record `pid:ms`). A lock whose holder
 * process is gone is reclaimed at once: a `/workspace` switch kills the source
 * window mid-write, and its successor starts within a second, far inside the
 * old 60 s age rule. A live holder (or this process) keeps the 60 s rule; an
 * unreadable record gets the agent-mesh lock's grace.
 */
export async function withRemoteStateLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options: { isAlive?: (pid: number) => boolean; timeoutMs?: number } = {},
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
        const [raw, stat] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)]);
        const match = /^(\d+):(\d+)\s*$/.exec(raw);
        const ageMs = Date.now() - stat.mtimeMs;
        const pid = match ? Number(match[1]) : undefined;
        const alive =
          pid === process.pid || (pid !== undefined && (options.isAlive ?? isProcessAlive)(pid));
        const stale =
          pid === undefined ? ageMs >= UNREADABLE_LOCK_GRACE_MS : !alive || ageMs >= LOCK_STALE_MS;
        if (stale) reclaim(lockPath, raw);
      } catch (inspectError) {
        // A lock being deleted or renamed opens with EPERM/EBUSY on Windows,
        // not ENOENT; it is the same "going away" state, so poll again.
        const code = (inspectError as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && !isLockContention(code)) throw inspectError;
      }
      if (Date.now() - started >= (options.timeoutMs ?? LOCK_TIMEOUT_MS)) {
        throw new Error(`Forge remote state lock timed out: ${lockPath}`);
      }
      await sleep(LOCK_WAIT_MS);
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

/** Removes aged atomic-write and reclaim artifacts belonging to this state file. */
export async function sweepRemoteStateTemps(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  const base = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const patterns = [
    new RegExp(`^\\.${base}\\.forge-[0-9a-f-]+\\.tmp$`, 'iu'),
    new RegExp(`^${base}\\.[0-9a-f-]+\\.tmp$`, 'iu'),
    new RegExp(`^${base}\\.lock\\.stale-[0-9a-f-]+$`, 'iu'),
  ];
  let removed = 0;
  const names = await fs.readdir(directory).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  for (const name of names) {
    if (!patterns.some((pattern) => pattern.test(name))) continue;
    const candidate = path.join(directory, name);
    const stat = await fs.stat(candidate).catch(() => undefined);
    if (!stat || Date.now() - stat.mtimeMs <= ORPHAN_TEMP_TTL_MS) continue;
    await fs
      .unlink(candidate)
      .then(() => removed++)
      .catch(() => undefined);
  }
  if (removed) log.info(`[remote] removed ${removed} orphaned state temp file(s)`);
}

/**
 * First read of the state file: the file itself, else the migrated legacy
 * file, else an empty state. Creation runs under the lock and rereads first,
 * so two windows starting together agree on one document. Orphaned temps
 * from killed writers are swept before anything is read.
 */
export async function openRemoteState(
  filePath: string,
  legacyFilePath: string | undefined,
): Promise<RemoteStoreState> {
  await sweepRemoteStateTemps(filePath);
  const existing = await readRemoteState(filePath);
  if (existing) return existing;
  return withRemoteStateLock(filePath, async () => {
    const raced = await readRemoteState(filePath);
    if (raced) return raced;
    let state = structuredClone(EMPTY_REMOTE_STATE);
    if (legacyFilePath) {
      try {
        state = migrateLegacyState(
          LegacyRemoteStateSchema.parse(JSON.parse(await fs.readFile(legacyFilePath, 'utf8'))),
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    await writeRemoteStateFile(filePath, JSON.stringify(state));
    return state;
  });
}

/** The parsed state file, or undefined when it does not exist yet. */
export async function readRemoteState(filePath: string): Promise<RemoteStoreState | undefined> {
  try {
    return RemoteStateSchema.parse(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return undefined;
  }
}
