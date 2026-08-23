/**
 * Single owner for "is this PID still running?".
 *
 * Used to reclaim resources whose owning process died without cleaning up —
 * today, shared-runtime lease files (`SharedRuntimeRegistry`).
 */

/**
 * True when `pid` names a live process.
 *
 * `process.kill(pid, 0)` sends no signal; it only performs the permission and
 * existence check. It throws `ESRCH` when the process is gone and `EPERM` when
 * the process exists but belongs to another user — EPERM is therefore a
 * liveness signal, not an error.
 *
 * Known limit: PIDs are recycled by the OS, so a reused PID reads as alive.
 * That fails conservatively (a stale resource survives one extra cycle) rather
 * than dangerously (reclaiming something still in use).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
