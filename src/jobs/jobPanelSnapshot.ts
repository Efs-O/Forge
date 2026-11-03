/**
 * The sessions panel's Jobs projection: store truth shaped for display, and
 * nothing else. Deliberally thin — the text comes from `jobDescribe.ts` so the
 * panel, `manage_jobs` and Telegram `/jobs` describe the same job the same
 * way, and a panel row is never a second copy of the store.
 */
import { describeJob, describeSchedule, lastRunOutcome, truncate } from './jobDescribe';
import type { JobStore } from './JobStore';

/** The longest outcome detail a row shows; the full text lives in the tooltip. */
export const JOB_DETAIL_MAX_CHARS = 120;

/** The newest recorded run, as the row shows it. */
export interface JobPanelLastRun {
  at: number;
  outcome: 'ok' | 'failed' | 'skipped';
  /** `error` when the run failed, else the run's summary — truncated. */
  detail: string;
}

/** One job row. All display text is host-formatted so surfaces cannot drift. */
export interface JobPanelMeta {
  id: string;
  name: string;
  /** `describeSchedule(job.schedule)` — e.g. "daily at 08:20". */
  schedule: string;
  enabled: boolean;
  /** `describeJob(jobFile)` — the row's full tooltip, the panel's `get`. */
  description: string;
  /** `lastRunOutcome(state)` — 'no runs yet' or 'failing ×N'. */
  lastOutcomeLabel: string;
  /**
   * `state.consecutive_failures` as a number, the count behind the `failing ×N`
   * label. The panel's status dot and its Jobs-tab badge need to know a job is
   * failing without reading their own meaning out of a string `jobDescribe.ts`
   * formats for three surfaces, so the count travels as itself.
   */
  consecutiveFailures: number;
  lastRun: JobPanelLastRun | null;
  /**
   * For an `agent_task` job, the conversation id its `task_run` names while a
   * run is in flight — null otherwise. The webview decides "Running" by
   * matching this against its own live streaming ids, so the marker clears
   * the moment the turn ends even if no store write follows.
   */
  runningConversationId: string | null;
}

/**
 * Read the store as the panel wants it, in `loadAll()`'s canonical order
 * (creation order, then id — the same order Telegram `/jobs` numbers, so the
 * two surfaces list the same jobs the same way).
 *
 * Each job is re-read after the listing: a job deleted between `loadAll` and
 * the row's own read is dropped here, not shown stale, and never resurrected.
 * A load error throws to the caller (the bridge keeps the previous snapshot
 * and reports the error) rather than returning a list that looks empty.
 */
export async function buildJobsPanelSnapshot(store: JobStore): Promise<JobPanelMeta[]> {
  const listed = await store.loadAll();
  const rows: JobPanelMeta[] = [];
  for (const first of listed) {
    const fresh = await store.load(first.job.id);
    if (!fresh) continue;
    const runs = await store.readRuns(fresh.job.id);
    const last = runs.length > 0 ? runs[runs.length - 1] : null;
    const taskConv =
      fresh.job.action?.kind === 'agent_task'
        ? (fresh.state.task_run?.conversation_id ?? null)
        : null;
    rows.push({
      id: fresh.job.id,
      name: fresh.job.name,
      schedule: describeSchedule(fresh.job.schedule),
      enabled: fresh.job.enabled,
      description: describeJob(fresh),
      lastOutcomeLabel: lastRunOutcome(fresh.state),
      consecutiveFailures: fresh.state.consecutive_failures,
      ...(last
        ? {
            lastRun: {
              at: last.at,
              outcome: last.outcome,
              detail: truncate(last.error ?? last.summary, JOB_DETAIL_MAX_CHARS),
            },
          }
        : { lastRun: null }),
      runningConversationId: taskConv,
    });
  }
  return rows;
}
