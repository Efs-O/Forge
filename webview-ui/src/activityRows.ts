import type { AppMessage } from './messageOps';
import type { ActivityViewMode } from '../../src/sidebar/activityViewSetting';

export type { ActivityViewMode };

export type Row =
  | { kind: 'message'; message: AppMessage; index: number }
  | { kind: 'diffGroup'; diffs: AppMessage[] }
  | { kind: 'thinkingGroup'; steps: AppMessage[] }
  | { kind: 'toolGroup'; tools: AppMessage[] };

/** True for an assistant message that carries only reasoning. */
export function isReasoningOnly(msg: AppMessage): boolean {
  return msg.role === 'assistant' && !msg.content && Boolean(msg.reasoning);
}

/**
 * Folds runs of adjacent same-kind messages into single rows: file edits and
 * tool calls become one card per turn, and per-round reasoning becomes one line.
 * Compact and grouped are reserved for later phases and currently retain every
 * row from the full view.
 */
export function toRows(messages: AppMessage[], _mode: ActivityViewMode): Row[] {
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
