/**
 * The sessions panel's display decisions that need no DOM: what a row's title
 * is, who its badge names, what a job row's status is, and what the search box
 * leaves in. Pure, so each rule is asserted directly rather than through a
 * render — the badge rules in particular are the ones a future change is most
 * likely to get wrong, because they read fields that are often absent.
 */
import type { JobPanelMeta } from '../../src/sidebar/messageBridge';
import { chatRowView, type ChatProvenance } from '../../src/sidebar/chatProvenance';
import { matchSessionSearch, parseSessionSearchQuery } from '../../src/sidebar/sessionSearchQuery';
import type { SessionSearchHit } from '../../src/sidebar/sessionSearchMessages';
export { chatRowView, type ChatProvenance } from '../../src/sidebar/chatProvenance';

/** Everything a job row says out loud, as one string to search. */
export function jobSearchText(job: JobPanelMeta): string {
  // The `2h ago` wording is left out on purpose: it moves with the clock, so a
  // match on it would be a match the same search misses tomorrow.
  return [
    job.name,
    job.lastOutcomeLabel,
    job.lastRun ? `${job.lastRun.outcome} ${job.lastRun.detail}` : '',
  ]
    .join('\n')
    .toLowerCase();
}

/**
 * Search results ranked by shared relevance score, then recency. An empty
 * query preserves the order the panel already has.
 *
 * Positive-only queries can show metadata matches immediately. Host matches
 * also include queries whose terms span metadata and saved text. Exclusions
 * require a host result because only the host can inspect the whole transcript.
 */
export function filterChatRows<T extends ChatProvenance & { id?: string; updatedAt?: number }>(
  rows: readonly T[],
  query: string,
  contentMatchIds?: ReadonlySet<string>,
  hits?: ReadonlyMap<string, SessionSearchHit>,
): T[] {
  const parsed = parseSessionSearchQuery(query);
  if (!parsed.include.length && !parsed.exclude.length) return [...rows];
  return rows
    .flatMap((row) => {
      const fields = { title: row.title, badge: chatRowView(row).badge.label };
      // A title cannot prove the absence of a term in an unread transcript.
      // Exclusion queries only draw rows the host has finished checking.
      const fromHost = row.id !== undefined && contentMatchIds?.has(row.id);
      if (parsed.exclude.length && !fromHost) return [];
      if (!matchSessionSearch({ include: [], exclude: parsed.exclude }, fields)) return [];
      const local = matchSessionSearch(parsed, fields);
      if (!local && !fromHost) return [];
      const score =
        (row.id === undefined ? undefined : hits?.get(row.id)?.score) ?? local?.score ?? 1;
      return [{ row, score }];
    })
    .sort((a, b) => b.score - a.score || (b.row.updatedAt ?? 0) - (a.row.updatedAt ?? 0))
    .map(({ row }) => row);
}

/** The jobs a query leaves. Name and last-outcome text, as the plan fixes them. */
export function filterJobRows(jobs: readonly JobPanelMeta[], query: string): JobPanelMeta[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...jobs];
  return jobs.filter((job) => jobSearchText(job).includes(needle));
}

/**
 * The four states a job row can show.
 *
 * `running` is this window's own streaming marker, not the store's: only the
 * webview knows whether a turn is live in front of the person reading it.
 * `none` covers both "no runs yet" and "the last run was skipped" — nothing
 * went out wrong and nothing went out right, so the dot stays hollow.
 */
export type JobRowStatus = 'running' | 'ok' | 'failing' | 'none';

/** A job's row state, from the store's numbers alone — never from label text. */
export function jobStatusOf(job: JobPanelMeta, running: boolean): JobRowStatus {
  if (running) return 'running';
  // The streak count, because that is what `failing ×N` means: a job that
  // failed once and has not run since is failing, one whose last run was
  // skipped is not.
  if (job.consecutiveFailures > 0) return 'failing';
  if (!job.lastRun) return 'none';
  if (job.lastRun.outcome === 'failed') return 'failing';
  return job.lastRun.outcome === 'ok' ? 'ok' : 'none';
}

/** Failing jobs, the number the Jobs tab shows in the error colour. */
export function failingJobCount(jobs: readonly JobPanelMeta[]): number {
  return jobs.filter((job) => jobStatusOf(job, false) === 'failing').length;
}

/** What the panel says when the search box has typed more than this tab has. */
export function noMatchMessage(query: string): string {
  return `Nothing matches "${query.trim()}".`;
}
