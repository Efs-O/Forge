import type { AppMessage } from './messageOps';
import { stepMessages, type ActivityGroupItem, type ActivityStep, type Row } from './activityRows';
import { diffStats } from '../../src/sidebar/diffMessages';

export const LONG_GROUP_AT = 10;
export const LONG_GROUP_TAIL = 6;

export interface GroupSummary {
  toolCalls: number;
  editCount: number;
  fileCount: number;
  fileLabel: string;
  added: number;
  removed: number;
  failed: number;
  retries: number;
  pending: boolean;
}

function isFailedAttempt(attempt: AppMessage[] | undefined): boolean {
  return Boolean(attempt?.some((tool) => tool.toolIsError));
}

function stepId(step: ActivityStep): string {
  return stepMessages(step)[0]!.id;
}

function finalTools(step: ActivityStep): AppMessage[] {
  return step.attempts.at(-1)?.tools ?? [];
}

function isSuccessfulTool(tool: AppMessage): boolean {
  return !tool.toolIsError && tool.toolResultTotal !== undefined;
}

function sameTargetCall(failed: AppMessage, succeeded: AppMessage): boolean {
  return Boolean(
    failed.toolName &&
    failed.toolTarget !== undefined &&
    failed.toolName === succeeded.toolName &&
    failed.toolTarget === succeeded.toolTarget,
  );
}

/** Step ids whose final-attempt failures a later same-target success recovered. */
export function recoveredFailures(items: ActivityGroupItem[]): ReadonlySet<string> {
  const recovered = new Set<string>();

  for (let index = 0; index < items.length; index++) {
    const failedTools = finalTools(items[index]!.step).filter((tool) => tool.toolIsError);
    if (failedTools.length === 0) continue;

    const laterTools = items.slice(index + 1).flatMap((item) => finalTools(item.step));
    if (
      failedTools.every((failed) =>
        laterTools.some((later) => isSuccessfulTool(later) && sameTargetCall(failed, later)),
      )
    ) {
      recovered.add(stepId(items[index]!.step));
    }
  }

  return recovered;
}

export interface GroupGap {
  kind: 'gap';
  /** The first hidden call keeps the disclosure key stable across remounts. */
  firstStepId: string;
  calls: number;
  leading: boolean;
}

export type VisibleGroupItem = ActivityGroupItem | GroupGap;

/**
 * Keeps short groups whole. Long groups retain their tail, every failure
 * that is still unrecovered, and every step the reader opened (`opened`, by
 * step id) - a step the reader is looking at must not slide into a gap as
 * later calls arrive. Hidden calls collapse into individually revealable
 * gaps.
 */
export function visibleGroupItems(
  items: ActivityGroupItem[],
  recovered: ReadonlySet<string>,
  revealed: ReadonlySet<string>,
  opened: ReadonlySet<string> = new Set(),
): VisibleGroupItem[] {
  const stepIndexes = items.map((_, index) => index);
  if (stepIndexes.length <= LONG_GROUP_AT) return items;

  const visibleStepIds = new Set(
    stepIndexes.slice(-LONG_GROUP_TAIL).map((index) => stepId(items[index]!.step)),
  );
  for (const index of stepIndexes) {
    const item = items[index]!;
    const id = stepId(item.step);
    if (opened.has(id)) visibleStepIds.add(id);
    if (isFailedAttempt(item.step.attempts.at(-1)?.tools)) {
      if (!recovered.has(id)) visibleStepIds.add(id);
    }
  }
  const itemIsVisible = items.map((item) => visibleStepIds.has(stepId(item.step)));

  const output: VisibleGroupItem[] = [];
  let shownCall = false;
  for (let index = 0; index < items.length; ) {
    if (itemIsVisible[index]) {
      const item = items[index]!;
      output.push(item);
      shownCall = true;
      index++;
      continue;
    }

    const start = index;
    let calls = 0;
    let firstStepId: string | undefined;
    while (index < items.length && !itemIsVisible[index]) {
      const hidden = items[index]!;
      calls++;
      firstStepId ??= stepId(hidden.step);
      index++;
    }

    if (firstStepId && revealed.has(firstStepId)) {
      output.push(...items.slice(start, index));
      if (calls > 0) shownCall = true;
    } else if (firstStepId) {
      output.push({ kind: 'gap', firstStepId, calls, leading: !shownCall });
    }
  }
  return output;
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
  const files = new Map<string, FileChange>();

  for (const item of items) {
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
    pending,
  };
}

/** Groups adjacent tool steps, keeping thinking blocks at transcript level. */
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
      flush();
      grouped.push(row);
    } else {
      flush();
      grouped.push(row);
    }
  }
  flush();
  return grouped;
}
