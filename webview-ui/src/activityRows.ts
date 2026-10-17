import type { AppMessage } from './messageOps';
import type { ActivityViewMode } from '../../src/sidebar/activityViewSetting';
import { groupActivity } from './activityGroups';

export type { ActivityViewMode };

/** One call of a step, with the reasoning that led to it. */
export interface StepAttempt {
  /** Reasoning-only assistant messages just before this attempt, in order. */
  thoughts: AppMessage[];
  /** One round's tool rows: one for a single call, several for a parallel round. */
  tools: AppMessage[];
}

/** One logical step of agent activity (compact view; plan § Proposal A). */
export interface ActivityStep {
  /**
   * Attempts of the same call, oldest first. More than one means a retry or a
   * plain repeat (×N). Thoughts sit on the attempt they preceded, so a retry's
   * reasoning renders before the retry and the step's first message (its
   * `rowKey`) never changes as attempts are appended.
   */
  attempts: StepAttempt[];
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

/** Every message in a step, in chronological order: each attempt's thoughts then tools, then diffs. */
export function stepMessages(step: ActivityStep): AppMessage[] {
  return [...step.attempts.flatMap((a) => [...a.thoughts, ...a.tools]), ...step.diffs];
}

/** All reasoning in a step, across attempts. */
export function stepThoughts(step: ActivityStep): AppMessage[] {
  return step.attempts.flatMap((a) => a.thoughts);
}

/** All tool rows in a step, across attempts. */
export function stepTools(step: ActivityStep): AppMessage[] {
  return step.attempts.flatMap((a) => a.tools);
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
 * Compact rows (plan § Proposal A, rules 1-4): each tool round becomes a step
 * carrying the reasoning before it and the diffs it produced.
 */
export function toCompactRows(messages: AppMessage[]): Row[] {
  const rows: Row[] = [];
  const stepByCallId = new Map<string, ActivityStep>();
  let thoughts: AppMessage[] = [];
  let previousStep: ActivityStep | undefined;
  let unmatchedDiffs: AppMessage[] = [];

  const flushUnmatchedDiffs = (): void => {
    if (unmatchedDiffs.length > 0) rows.push({ kind: 'diffGroup', diffs: unmatchedDiffs });
    unmatchedDiffs = [];
  };
  const flushThoughts = (): void => {
    if (thoughts.length > 0) rows.push({ kind: 'thinkingGroup', steps: thoughts });
    thoughts = [];
  };

  for (let i = 0; i < messages.length; ) {
    const message = messages[i]!;

    if (isReasoningOnly(message)) {
      flushUnmatchedDiffs();
      thoughts.push(message);
      i++;
      continue;
    }

    if (message.role === 'tool') {
      flushUnmatchedDiffs();
      let end = i + 1;
      while (end < messages.length && messages[end]!.role === 'tool') end++;
      const round = messages.slice(i, end);
      const last = previousStep?.attempts.at(-1)?.tools;
      const canMerge =
        round.length === 1 &&
        last?.length === 1 &&
        sameTarget(last[0]!, round[0]!) &&
        (isFailed(last) ||
          (!hasDiffForAttempt(previousStep!, last) && !hasDiffForRound(round, messages, end)));

      const attempt: StepAttempt = { thoughts, tools: round };
      if (canMerge) {
        previousStep!.attempts.push(attempt);
      } else {
        previousStep = { attempts: [attempt], diffs: [] };
        rows.push({ kind: 'step', step: previousStep });
      }
      for (const tool of round) {
        if (tool.toolCallId) stepByCallId.set(tool.toolCallId, previousStep!);
      }
      thoughts = [];
      i = end;
      continue;
    }

    if (message.role === 'diff') {
      const owner = message.toolCallId ? stepByCallId.get(message.toolCallId) : undefined;
      if (owner) owner.diffs.push(message);
      else unmatchedDiffs.push(message);
      i++;
      continue;
    }

    flushUnmatchedDiffs();
    flushThoughts();
    rows.push({ kind: 'message', message, index: i });
    previousStep = undefined;
    i++;
  }

  flushUnmatchedDiffs();
  flushThoughts();
  return rows;
}

function sameTarget(previous: AppMessage, next: AppMessage): boolean {
  return (
    previous.toolName === next.toolName &&
    previous.toolTarget !== undefined &&
    next.toolTarget !== undefined &&
    previous.toolTarget === next.toolTarget
  );
}

function isFailed(tools: AppMessage[]): boolean {
  return tools.some((message) => message.toolIsError);
}

function hasDiffForAttempt(step: ActivityStep, attempt: AppMessage[]): boolean {
  const ids = new Set(
    attempt.map((message) => message.toolCallId).filter((id): id is string => Boolean(id)),
  );
  return step.diffs.some((diff) => Boolean(diff.toolCallId && ids.has(diff.toolCallId)));
}

function hasDiffForRound(round: AppMessage[], messages: AppMessage[], start: number): boolean {
  const ids = new Set(
    round.map((message) => message.toolCallId).filter((id): id is string => Boolean(id)),
  );
  for (let i = start; i < messages.length && messages[i]!.role === 'diff'; i++) {
    if (messages[i]!.toolCallId && ids.has(messages[i]!.toolCallId!)) return true;
  }
  return false;
}

/** Shortens only the visible shell detail; ToolRow retains the original command. */
export function displayDetail(detail: string): string {
  return detail.replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*(?:&&|;)\s*)+/u, '');
}

/**
 * Folds runs of adjacent same-kind messages into single rows: file edits and
 * tool calls become one card per turn, and per-round reasoning becomes one line.
 */
function toFullRows(messages: AppMessage[]): Row[] {
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
