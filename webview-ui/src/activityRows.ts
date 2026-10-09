import type { AppMessage } from './messageOps';
import type { ActivityViewMode } from '../../src/sidebar/activityViewSetting';
import { groupActivity } from './activityGroups';

export type { ActivityViewMode };

/** One logical step of agent activity (compact view; plan § Proposal A). */
export interface ActivityStep {
  /** Reasoning-only assistant messages that preceded the call(s), in order. */
  thoughts: AppMessage[];
  /**
   * Attempts of the same call, oldest first. Each attempt is one round's tool
   * rows: one row for a single call, several for a parallel round. More than
   * one attempt means a retry or a plain repeat (×N).
   */
  attempts: AppMessage[][];
  /** Diff rows produced by this step's calls, matched by `toolCallId`. */
  diffs: AppMessage[];
}

/** What an `activityGroup` row holds: steps, and thinking runs between them. */
export type ActivityGroupItem =
  | { kind: 'step'; step: ActivityStep }
  | { kind: 'thinkingGroup'; steps: AppMessage[] };

export type Row =
  | { kind: 'message'; message: AppMessage; index: number }
  | { kind: 'diffGroup'; diffs: AppMessage[] }
  | { kind: 'thinkingGroup'; steps: AppMessage[] }
  | { kind: 'toolGroup'; tools: AppMessage[] }
  | { kind: 'step'; step: ActivityStep }
  | { kind: 'activityGroup'; items: ActivityGroupItem[] };

/** Every message in a step, in chronological order: thoughts, attempts, diffs. */
export function stepMessages(step: ActivityStep): AppMessage[] {
  return [...step.thoughts, ...step.attempts.flat(), ...step.diffs];
}

/** Every message in a group, in order. */
export function groupMessages(items: ActivityGroupItem[]): AppMessage[] {
  return items.flatMap((item) => (item.kind === 'step' ? stepMessages(item.step) : item.steps));
}

/**
 * The React key of a row: its first message's id. Must not change while a
 * step grows (a retry appends) or across a turn-end sync (plan § Expand state).
 */
export function rowKey(row: Row): string {
  switch (row.kind) {
    case 'message':
      return row.message.id;
    case 'diffGroup':
      return row.diffs[0]!.id;
    case 'thinkingGroup':
      return row.steps[0]!.id;
    case 'toolGroup':
      return row.tools[0]!.id;
    case 'step':
      return stepMessages(row.step)[0]!.id;
    case 'activityGroup':
      return groupMessages(row.items)[0]!.id;
  }
}

/** True for an assistant message that carries only reasoning. */
export function isReasoningOnly(msg: AppMessage): boolean {
  return msg.role === 'assistant' && !msg.content && Boolean(msg.reasoning);
}

/**
 * Builds the transcript rows for a view mode. `full` is today's folding,
 * pinned by the golden tests; `compact` builds steps; `grouped` groups the
 * compact rows.
 */
export function toRows(messages: AppMessage[], mode: ActivityViewMode): Row[] {
  if (mode === 'full') return toFullRows(messages);
  const compact = toCompactRows(messages);
  return mode === 'compact' ? compact : groupActivity(compact);
}

/**
 * Compact rows (plan § Proposal A, rules 1-4). Phase 2 replaces this body;
 * until then it returns the full rows.
 */
export function toCompactRows(messages: AppMessage[]): Row[] {
  return toFullRows(messages);
}

/**
 * Folds runs of adjacent same-kind messages into single rows: file edits and
 * tool calls become one card per turn, and per-round reasoning becomes one line.
 */
export function toFullRows(messages: AppMessage[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    if (message.role === 'diff') {
      const diffs: AppMessage[] = [];
      while (i < messages.length && messages[i]!.role === 'diff') diffs.push(messages[i++]!);
      i--;
      rows.push({ kind: 'diffGroup', diffs });
      continue;
    }

    if (isReasoningOnly(message)) {
      const steps: AppMessage[] = [];
      while (i < messages.length && isReasoningOnly(messages[i]!)) steps.push(messages[i++]!);
      i--;
      rows.push({ kind: 'thinkingGroup', steps });
      continue;
    }

    if (message.role === 'tool') {
      const tools: AppMessage[] = [];
      while (i < messages.length && messages[i]!.role === 'tool') tools.push(messages[i++]!);
      i--;
      rows.push({ kind: 'toolGroup', tools });
      continue;
    }

    rows.push({ kind: 'message', message, index: i });
  }
  return rows;
}
