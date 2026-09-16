import * as fs from 'fs/promises';
import type { CheckContext, CheckResult } from './checkTypes';
import type { DiskSpaceCheck } from '../jobSchema';

const GB = 1024 * 1024 * 1024;

/**
 * Local check: report a change when free space on a path drops below
 * `min_free_gb`. No network. The observation is the current free space in GB
 * (one decimal), so the run log shows the trend.
 *
 * `changed` is true on either threshold crossing. A job that stays on the
 * same side does not re-fire on every poll.
 */
export async function diskSpaceCheck(
  check: DiskSpaceCheck,
  lastObservation: string | null,
  _ctx: CheckContext,
): Promise<CheckResult> {
  const stats = await fs.statfs(check.path);
  const freeGb = (stats.bavail * stats.bsize) / GB;
  const observation = freeGb.toFixed(1);
  const below = freeGb < check.min_free_gb;

  let changed = false;
  if (lastObservation !== null) {
    // The first run only records a baseline. Thereafter both recovery (below
    // to above) and warning (above to below) are meaningful changes.
    const wasBelow = parseFloat(lastObservation) < check.min_free_gb;
    changed = wasBelow !== below;
  }

  return {
    observation,
    changed,
    summary: below
      ? `only ${freeGb.toFixed(1)} GB free on ${check.path} (below ${check.min_free_gb} GB)`
      : `${freeGb.toFixed(1)} GB free on ${check.path}`,
  };
}
