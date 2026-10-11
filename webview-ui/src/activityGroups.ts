import type { AppMessage } from './messageOps';
import { stepThoughts, type ActivityGroupItem, type Row } from './activityRows';
import { diffStats } from '../../src/sidebar/diffMessages';
import { formatDuration } from '../../src/util/formatDuration';

export interface GroupSummary {
  toolCalls: number;
  editCount: number;
  fileCount: number;
  fileLabel: string;
  added: number;
  removed: number;
  failed: number;
  retries: number;
  hasThinking: boolean;
  thinking: string;
  pending: boolean;
}

function isFailedAttempt(attempt: AppMessage[] | undefined): boolean {
  return Boolean(attempt?.some((tool) => tool.toolIsError));
}

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

interface FileChange {
  added: number;
  removed: number;
  /** The group's first write to this file created it. */
  created: boolean;
}

/**
 * A file the group created is its final size, all added: a 494-line write
 * then a +2 −3 edit is +493, not +496 −3 (nothing existed to remove). A file
 * that already existed keeps the summed counts, which overstate only where a
 * later edit rewrites lines an earlier one wrote.
 */
function netChange(file: FileChange): { added: number; removed: number } {
  if (!file.created) return file;
  return { added: Math.max(0, file.added - file.removed), removed: 0 };
}

/** Pure summary values used by the grouped header and its unit tests. */
export function summarizeGroup(items: ActivityGroupItem[]): GroupSummary {
  let toolCalls = 0;
  let editCount = 0;
  let added = 0;
  let removed = 0;
  let failed = 0;
  let retries = 0;
  let pending = false;
  let hasThinking = false;
  const reasoningTimes: number[] = [];
  const files = new Map<string, FileChange>();

  for (const item of items) {
    const thoughts = item.kind === 'step' ? stepThoughts(item.step) : item.steps;
    if (thoughts.length > 0) hasThinking = true;
    for (const thought of thoughts) {
      if (thought.reasoningMs !== undefined) reasoningTimes.push(thought.reasoningMs);
    }

    if (item.kind !== 'step') continue;
    const { step } = item;
    const tools = step.attempts.flatMap((attempt) => attempt.tools);
    toolCalls += tools.length;
    pending ||= tools.some((tool) => tool.toolResultTotal === undefined && !tool.toolIsError);

    const finalFailed = isFailedAttempt(step.attempts.at(-1)?.tools);
    if (finalFailed) failed += 1;
    else retries += step.attempts.slice(0, -1).filter((a) => isFailedAttempt(a.tools)).length;

    for (const diff of step.diffs) {
      editCount += 1;
      const stats = diffStats(diff.diffHunks);
      const file = files.get(diff.content) ?? {
        added: 0,
        removed: 0,
        created: Boolean(diff.diffIsNew),
      };
      file.added += stats.added;
      file.removed += stats.removed;
      files.set(diff.content, file);
    }
  }
  for (const file of files.values()) {
    const net = netChange(file);
    added += net.added;
    removed += net.removed;
  }

  const seconds =
    reasoningTimes.length > 0
      ? (formatDuration(reasoningTimes.reduce((sum, ms) => sum + ms, 0)) ?? '')
      : '';
  const fileLabel =
    files.size === 1 ? `to ${basename([...files.keys()][0]!)}` : `in ${files.size} files`;

  return {
    toolCalls,
    editCount,
    fileCount: files.size,
    fileLabel,
    added,
    removed,
    failed,
    retries,
    hasThinking,
    thinking: seconds,
    pending,
  };
}

/** Groups each maximal step/thinking run with at least one tool step. */
export function groupActivity(rows: Row[]): Row[] {
  const grouped: Row[] = [];
  let run: ActivityGroupItem[] = [];
  let runRows: Row[] = [];
  let stepCount = 0;

  const flush = (): void => {
    if (stepCount > 0) grouped.push({ kind: 'activityGroup', items: run });
    else grouped.push(...runRows);
    run = [];
    runRows = [];
    stepCount = 0;
  };

  for (const row of rows) {
    if (row.kind === 'step') {
      run.push({ kind: 'step', step: row.step });
      runRows.push(row);
      stepCount += 1;
    } else if (row.kind === 'thinkingGroup') {
      run.push({ kind: 'thinkingGroup', steps: row.steps });
      runRows.push(row);
    } else {
      flush();
      grouped.push(row);
    }
  }
  flush();
  return grouped;
}
