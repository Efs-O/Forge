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
 * Age alone never makes a holder stale, so a slow-but-live holder is waited on,
 * never raced into a duplicate.
 */

interface LockRecord {
  host_pid: number;
  host_started_at: number;
}

/** A short blocking pause while waiting for a live holder to release. */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin: the lock is held for one short write, so contention is rare */
  }
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Acquire `lockPath` for `holder`, waiting up to `deadline` (epoch ms) for a
 * live holder to release. A dead holder's lock is reclaimed; a lock whose
 * holder is this host is reclaimed (never deadlock on ourselves). Throws when
 * a live holder still holds it at the deadline.
 */
export function acquireLock(
  lockPath: string,
  holder: HostId,
  deps: HostLivenessDeps,
  deadline: number,
): void {
  const alive = deps.isHostAlive ?? ((h: HostId) => isHostAlive(h, deps));
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(
          fd,
          JSON.stringify({ host_pid: holder.pid, host_started_at: holder.startedAt }),
        );
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let rec: LockRecord | undefined;
    try {
      rec = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockRecord;
    } catch {
      rec = undefined; // torn/empty: treat as stale
    }
    const holderId: HostId | undefined =
      rec && Number.isFinite(rec.host_pid) && Number.isFinite(rec.host_started_at)
        ? { pid: rec.host_pid, startedAt: rec.host_started_at }
        : undefined;
    if (holderId && holderId.pid === holder.pid) {
      unlinkQuiet(lockPath);
      continue;
    }
    if (holderId && !alive(holderId)) {
      unlinkQuiet(lockPath); // holder proven dead: reclaim
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `lock ${lockPath} held by live host pid ${holderId?.pid ?? '?'}; giving up after deadline`,
      );
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
