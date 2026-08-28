/** Merge and render host-recorded action facts across compaction generations. */

import { RECORDED_ACTION_MAX_PER_KIND, type RecordedCompactionAction } from './compactionTypes';

function capActions(actions: readonly RecordedCompactionAction[]): {
  actions: RecordedCompactionAction[];
  omitted: number;
} {
  if (actions.length <= RECORDED_ACTION_MAX_PER_KIND) {
    return { actions: [...actions], omitted: 0 };
  }
  const kept = new Set<number>();
  for (const [index, action] of actions.entries()) {
    if (action.outcome !== 'ok' && kept.size < RECORDED_ACTION_MAX_PER_KIND) kept.add(index);
  }
  for (const [index, action] of actions.entries()) {
    if (action.durableEvidence && kept.size < RECORDED_ACTION_MAX_PER_KIND) kept.add(index);
  }
  for (const [index] of actions.entries()) {
    if (kept.size >= RECORDED_ACTION_MAX_PER_KIND) break;
    kept.add(index);
  }
  return {
    actions: actions.filter((_, index) => kept.has(index)),
    omitted: actions.length - kept.size,
  };
}

function section(title: string, actions: readonly RecordedCompactionAction[]): string {
  if (actions.length === 0) return '';
  const { actions: kept, omitted } = capActions(actions);
  const more = omitted > 0 ? `\n- …and ${omitted} more` : '';
  return `\n\n**${title} (recorded by Forge, not written by the model):**\n${kept.map((action) => action.line).join('\n')}${more}`;
}

/** Later observations replace earlier facts with the same stable key. */
export function mergeRecordedActions(
  previous: readonly RecordedCompactionAction[] | undefined,
  current: readonly RecordedCompactionAction[],
): RecordedCompactionAction[] {
  const latest = new Map<string, RecordedCompactionAction>();
  for (const action of [...(previous ?? []), ...current]) {
    latest.delete(action.key);
    latest.set(action.key, { ...action });
  }
  const merged = [...latest.values()];
  return (['file', 'command'] as const).flatMap(
    (kind) => capActions(merged.filter((action) => action.kind === kind)).actions,
  );
}

export function renderRecordedActionsBlock(actions: readonly RecordedCompactionAction[]): string {
  return (
    section(
      'File changes',
      actions.filter((action) => action.kind === 'file'),
    ) +
    section(
      'Commands run',
      actions.filter((action) => action.kind === 'command'),
    )
  );
}
