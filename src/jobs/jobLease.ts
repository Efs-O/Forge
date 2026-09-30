/**
 * Scheduler lease lifecycle, extracted from `JobScheduler` (pure move — no
 * behaviour change). The `jobs-scheduler` lease is the single-writer lock on
 * the jobs root; the scheduler holds it for the life of the window and
 * re-acquires on every tick that finds itself without one, so a lost lease is
 * recovered rather than fatal.
 */

import { FileLease } from '../util/FileLease';
import { SCHEDULER_LEASE_KEY, type WakeReconciler } from './schedulerWakes';

/**
 * Try to take the `jobs-scheduler` lease. Returns the lease on success, or
 * undefined when another window holds it. `onLost` fires when the lease is
 * stolen or a heartbeat fails; the caller clears its handle and stays alive
 * (the next tick re-acquires) — never a full `stop()`, which would make a
 * transient loss permanent while the scheduled wake kept waking the machine.
 */
export async function acquireSchedulerLease(
  directory: string,
  workspaceId: string,
  instanceId: string,
  onLost: () => void,
  wakes: WakeReconciler,
): Promise<FileLease | undefined> {
  try {
    const lease = await FileLease.acquire({
      directory,
      key: SCHEDULER_LEASE_KEY,
      workspaceId,
      instanceId,
      onLost,
    });
    wakes.reset();
    return lease;
  } catch {
    return undefined;
  }
}
