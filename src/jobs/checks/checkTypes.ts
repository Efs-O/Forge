import type { JobsFetchResult } from '../jobsFetch';

/**
 * What a check reports back to the scheduler.
 *
 * `observation` is the stable value the check tracks (a tag, a timestamp, a
 * free-space figure). The scheduler stores it as `state.last_observation` and
 * passes it back on the next run; `changed` tells the scheduler whether the
 * action should fire. A 304 / no-change run returns `changed: false` and keeps
 * the previous observation.
 */
export interface CheckResult {
  /** The value to store as the new `last_observation`. */
  observation: string;
  /** Whether the check reports a change worth acting on. */
  changed: boolean;
  /** One line for the run log. */
  summary: string;
}

/**
 * What the scheduler hands a check. `fetch` is the gated, ETag-cached fetch
 * (D5) — a check never calls `fetch` directly, so the host gate and the cache
 * cannot be bypassed.
 */
export interface CheckContext {
  fetch(url: string): Promise<JobsFetchResult>;
  /** The ETag cache, shared across checks for the run. */
  etagCache: Map<string, string>;
  /** The allowed hosts, for error messages. */
  allowedHosts: readonly string[];
}
