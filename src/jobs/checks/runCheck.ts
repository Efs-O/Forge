import { jobsFetch } from '../jobsFetch';
import { githubIssueCheck, githubReleaseCheck } from './github';
import { diskSpaceCheck } from './diskSpace';
import type { CheckContext } from './checkTypes';
import type { CheckResult } from './checkTypes';
import type { JobFile } from '../jobSchema';

/**
 * The check dispatch: given a job and its state, run the right check and
 * return the result. Extracted from JobScheduler to keep that file under the
 * 500-line hard stop.
 */
export async function runCheck(job: JobFile, ctx: CheckContext): Promise<CheckResult> {
  const { job: def, state } = job;
  const lastObservation = state.last_observation;

  switch (def.check.kind) {
    case 'github_release':
      return githubReleaseCheck(def.check, lastObservation, ctx);
    case 'github_issue':
      return githubIssueCheck(def.check, lastObservation, ctx);
    case 'disk_space':
      return diskSpaceCheck(def.check, lastObservation, ctx);
    case 'none':
      // No check: always reports a change with an empty observation.
      return { observation: '', changed: true, summary: 'no check (runs every tick)' };
  }
}

/**
 * Build a CheckContext for a job run. The ETag cache is keyed PER JOB, not per
 * URL alone; the scheduler owns this cache so separate scheduler instances do
 * not share in-memory state.
 */
export function buildCheckContext(
  allowedHosts: readonly string[],
  jobId: string,
  etagCache: Map<string, string>,
): CheckContext {
  return {
    fetch: (url) => jobsFetch(url, { allowedHosts, etagCache, cacheKeyPrefix: jobId }),
    etagCache,
    allowedHosts,
  };
}
