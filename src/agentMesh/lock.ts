import { randomUUID } from 'crypto';
import * as fs from 'fs';
import type { HostId, HostLivenessDeps } from './hostIdentity';
import { getHostIdentity, isHostAlive } from './hostIdentity';

/**
 * The M1 interprocess lock, shared by every durable bus artifact that does a
 * read-modify-write (the exchanges log and the alias registry). Two extension
 * hosts share `~/.forge/agent-bus/`, so a whole-file rename (the alias table,
 * F-14) must be serialized the same way a log append is: hold a lock file whose
 * name is the host that holds it, and reclaim it only when that host is proven
 * dead (pid gone, or the pid was recycled — its start time no longer matches).
 * Age alone never makes a readable holder stale, so a slow-but-live holder is
 * waited on, never raced into a duplicate.
 */

interface LockRecord {
  host_pid: number;
  host_started_at: number;
}

/**
 * How long an unreadable lock must sit untouched before it counts as an orphan.
 * A lock is published whole (below), so a live acquirer never leaves one
 * unreadable; the grace only covers a build that still creates then writes.
 */
export const UNREADABLE_LOCK_GRACE_MS = 2_000;

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * A short blocking pause while a live holder finishes. The callers are
 * synchronous, so this still blocks the thread, but it sleeps rather than
 * spinning a core for the whole wait (audit A5).
 */
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Publish the lock with its owner record already inside: write a private
 * temporary, then hard-link it into place. The link either fails (EEXIST) or
 * makes a complete record appear at once, so no crash can leave an empty lock
 * behind — creating the file and writing it separately could (audit A5).
 */
function tryPublish(lockPath: string, holder: HostId): boolean {
  const tmp = `${lockPath}.${holder.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ host_pid: holder.pid, host_started_at: holder.startedAt }),
  );
  try {
    fs.linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  } finally {
    unlinkQuiet(tmp);
  }
}

/**
 * Remove a lock judged stale from the bytes in `seen`. The lock is first
 * renamed aside, so of two recoverers only one gets it; if what was renamed
 * is no longer what was judged (a new holder published in between), it is
 * linked back rather than deleted.
 */
function reclaim(lockPath: string, seen: string): void {
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // another recoverer won
    throw err;
  }
  try {
    if (fs.readFileSync(aside, 'utf8') !== seen) fs.linkSync(aside, lockPath);
  } finally {
    unlinkQuiet(aside);
  }
}

/** The lock's raw content and its age, or undefined if it vanished meanwhile. */
function inspect(lockPath: string): { raw: string; ageMs: number } | undefined {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return { raw, ageMs: Date.now() - fs.statSync(lockPath).mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function parseHolder(raw: string): HostId | undefined {
  try {
    const rec = JSON.parse(raw) as LockRecord;
    return Number.isFinite(rec.host_pid) && Number.isFinite(rec.host_started_at)
      ? { pid: rec.host_pid, startedAt: rec.host_started_at }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Acquire `lockPath` for `holder`, waiting up to `deadline` (epoch ms) for a
 * live holder to release. A dead holder's lock is reclaimed; a lock whose
 * holder is this host is reclaimed (never deadlock on ourselves); an
 * unreadable lock is reclaimed once it is older than the grace. Throws when a
 * live holder still holds it at the deadline.
 */
export function acquireLock(
  lockPath: string,
  holder: HostId,
  deps: HostLivenessDeps,
  deadline: number,
): void {
  const alive = deps.isHostAlive ?? ((h: HostId) => isHostAlive(h, deps));
  for (;;) {
    if (tryPublish(lockPath, holder)) return;
    const seen = inspect(lockPath);
    if (!seen) continue;
    const holderId = parseHolder(seen.raw);
    const orphan = holderId
      ? holderId.pid === holder.pid || !alive(holderId)
      : seen.ageMs >= UNREADABLE_LOCK_GRACE_MS;
    if (orphan) {
      reclaim(lockPath, seen.raw);
      continue;
    }
    if (Date.now() >= deadline) {
      const who = holderId ? `live host pid ${holderId.pid}` : 'an unreadable record';
      throw new Error(`lock ${lockPath} held by ${who}; giving up after deadline`);
    }
    sleepSync(20);
  }
}

/** Release `lockPath` only if we still hold it (never unlink someone else's). */
export function releaseLock(lockPath: string, holder: HostId): void {
  try {
    const rec = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockRecord;
    if (rec.host_pid === holder.pid && rec.host_started_at === holder.startedAt) {
      unlinkQuiet(lockPath);
    }
  } catch {
    // Not ours or unreadable: leave it.
  }
}

/**
 * Run `fn` while holding `lockPath`. The holder is the calling host (or
 * `deps.selfPid`). Used to serialize a read-modify-write of a whole durable
 * file (the alias table, F-14) against another extension host.
 */
export function withLock<T>(
  lockPath: string,
  deps: HostLivenessDeps,
  timeoutMs: number,
  fn: () => T,
): T {
  const holder = getHostIdentity(deps);
  acquireLock(lockPath, holder, deps, Date.now() + timeoutMs);
  try {
    return fn();
  } finally {
    releaseLock(lockPath, holder);
  }
}
