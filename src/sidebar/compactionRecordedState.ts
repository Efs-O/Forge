/**
 * Merge, cap and render host-recorded action facts across compaction
 * generations.
 *
 * Two properties matter more than compactness here, and the original filling
 * order had neither:
 *
 *  - **Recent completed work must survive.** The first version filled the 24
 *    slots with non-successes first, in insertion order, and merged entries run
 *    oldest to newest — so a run of old failures could evict every recent
 *    success. An agent then resumed with a ledger listing what had gone wrong
 *    hours ago and nothing about what it had just finished, and redid the work.
 *  - **An omission must be visible.** A ledger is read as the record of what
 *    happened; entries dropped silently are indistinguishable from actions that
 *    never occurred. The count is therefore carried across generations rather
 *    than recomputed from a list that has already been cut.
 */

import { RECORDED_ACTION_MAX_PER_KIND, type RecordedCompactionAction } from './compactionTypes';

export interface OmittedActionCounts {
  file: number;
  command: number;
}

export const NO_OMITTED_ACTIONS: OmittedActionCounts = { file: 0, command: 0 };

/**
 * Slot reserves, per kind. They sum to the cap, and no category can take every
 * slot: whichever category is over its reserve yields first, and unclaimed
 * reserve is redistributed by recency.
 */
const RESERVE = {
  /** Latest failures and unknowns — the things still possibly blocking. */
  unresolved: 8,
  /** Successes carrying quoted output evidence, which is expensive to re-derive. */
  durable: 4,
  /** Recent plain successes — the completed work the agent must not repeat. */
  recent: 12,
} as const;

function isUnresolved(action: RecordedCompactionAction): boolean {
  return action.outcome !== 'ok';
}

/**
 * Keep at most `RECORDED_ACTION_MAX_PER_KIND` actions, newest-first within each
 * category, and report how many were dropped.
 *
 * `actions` is oldest to newest; the result preserves that order, because the
 * rendered block reads as a history.
 */
export function capActions(actions: readonly RecordedCompactionAction[]): {
  actions: RecordedCompactionAction[];
  omitted: number;
} {
  if (actions.length <= RECORDED_ACTION_MAX_PER_KIND) {
    return { actions: [...actions], omitted: 0 };
  }

  const kept = new Set<number>();
  const indexed = actions.map((action, index) => ({ action, index }));
  const newestFirst = [...indexed].reverse();

  const take = (predicate: (action: RecordedCompactionAction) => boolean, limit: number): void => {
    let taken = 0;
    for (const { action, index } of newestFirst) {
      if (taken >= limit || kept.size >= RECORDED_ACTION_MAX_PER_KIND) break;
      if (kept.has(index) || !predicate(action)) continue;
      kept.add(index);
      taken += 1;
    }
  };

  take(isUnresolved, RESERVE.unresolved);
  take((action) => action.durableEvidence === true, RESERVE.durable);
  take((action) => !isUnresolved(action), RESERVE.recent);
  // Whatever reserve went unclaimed goes to the most recent entries of any kind.
  take(() => true, RECORDED_ACTION_MAX_PER_KIND);

  return {
    actions: actions.filter((_, index) => kept.has(index)),
    omitted: actions.length - kept.size,
  };
}

function section(
  title: string,
  actions: readonly RecordedCompactionAction[],
  carriedOmissions: number,
): string {
  if (actions.length === 0 && carriedOmissions === 0) return '';
  const { actions: kept, omitted } = capActions(actions);
  const total = omitted + carriedOmissions;
  // Say that history was dropped, not that it did not happen. A resumed agent
  // reading a short list otherwise concludes the missing work was never done.
  const more =
    total > 0
      ? `\n- …and ${total} older recorded ${total === 1 ? 'entry' : 'entries'} omitted for space (they happened; they are not listed here)`
      : '';
  if (kept.length === 0) {
    return `\n\n**${title} (recorded by Forge, not written by the model):**${more}`;
  }
  return `\n\n**${title} (recorded by Forge, not written by the model):**\n${kept.map((action) => action.line).join('\n')}${more}`;
}

/**
 * Later observations replace earlier facts with the same stable key.
 *
 * Replacement, not accumulation: a command that failed and then succeeded must
 * not leave the failure standing as an unresolved blocker. The dropped count is
 * returned so the caller can persist it — recomputing it later from an
 * already-capped list would always report zero.
 */
export function mergeRecordedActions(
  previous: readonly RecordedCompactionAction[] | undefined,
  current: readonly RecordedCompactionAction[],
  previousOmitted: OmittedActionCounts | undefined = undefined,
): { actions: RecordedCompactionAction[]; omitted: OmittedActionCounts } {
  const latest = new Map<string, RecordedCompactionAction>();
  for (const action of [...(previous ?? []), ...current]) {
    // Delete first so a superseding observation also takes the newest position.
    latest.delete(action.key);
    latest.set(action.key, { ...action });
  }
  const merged = [...latest.values()];

  const actions: RecordedCompactionAction[] = [];
  const omitted: OmittedActionCounts = { ...(previousOmitted ?? NO_OMITTED_ACTIONS) };
  for (const kind of ['file', 'command'] as const) {
    const capped = capActions(merged.filter((action) => action.kind === kind));
    actions.push(...capped.actions);
    omitted[kind] += capped.omitted;
  }
  return { actions, omitted };
}

export function renderRecordedActionsBlock(
  actions: readonly RecordedCompactionAction[],
  omitted: OmittedActionCounts | undefined = undefined,
): string {
  const counts = omitted ?? NO_OMITTED_ACTIONS;
  return (
    section(
      'File changes',
      actions.filter((action) => action.kind === 'file'),
      counts.file,
    ) +
    section(
      'Commands run',
      actions.filter((action) => action.kind === 'command'),
      counts.command,
    )
  );
}
