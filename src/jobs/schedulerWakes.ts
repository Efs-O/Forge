import { FileLease, FileLeaseError } from '../util/FileLease';
import type { PowerControl } from '../system/PowerControl';
import type { RecurringWake } from '../system/wakeTaskXml';

/**
 * Ownership of the machine-wide `ForgeScheduledWake` task.
 *
 * There is one task per machine and any number of Forge windows, so the task
 * has exactly one writer: the window holding the `jobs-scheduler` lease. That
 * applies to deletion as much as to registration — a jobs-disabled window that
 * deleted the task unconditionally on activation removed the wakes of another
 * window that was still running enabled wake jobs (audit A7).
 */

/** The lease key that makes a window the scheduler — and the wake task's writer. */
export const SCHEDULER_LEASE_KEY = 'jobs-scheduler';

/**
 * The lease holder's side: register the computed schedule, but only when it
 * differs from what this holder last registered. A reconcile runs on every
 * store change, and registering unconditionally ran a PowerShell probe plus
 * `schtasks /create` for edits that could not have changed a wake (audit A4).
 */
export class WakeReconciler {
  private registered: string | undefined;

  constructor(private readonly power: Pick<PowerControl, 'setScheduledWakes'>) {}

  /**
   * Forget the last registration. Called on lease (re)acquisition: a new
   * holder must re-register rather than trust a task from a previous life.
   */
  reset(): void {
    this.registered = undefined;
  }

  async reconcile(wakes: readonly RecurringWake[]): Promise<void> {
    const key = JSON.stringify(wakes);
    if (key === this.registered) return;
    await this.power.setScheduledWakes(wakes);
    this.registered = key;
  }
}

/**
 * A window with jobs disabled: delete a stale task only when no live scheduler
 * owns it. Takes the scheduler lease for the duration of the delete so that a
 * window starting up cannot register in between. Returns whether it deleted;
 * false means a live window owns the task and it was left alone.
 */
export async function clearWakesIfUnowned(options: {
  power: Pick<PowerControl, 'setScheduledWakes'>;
  directory: string;
  workspaceId: string;
  instanceId: string;
}): Promise<boolean> {
  let lease: FileLease;
  try {
    lease = await FileLease.acquire({
      directory: options.directory,
      key: SCHEDULER_LEASE_KEY,
      workspaceId: options.workspaceId,
      instanceId: options.instanceId,
      onLost: () => undefined,
    });
  } catch (err) {
    if (err instanceof FileLeaseError) return false;
    throw err;
  }
  try {
    await options.power.setScheduledWakes([]);
    return true;
  } finally {
    await lease.release();
  }
}
