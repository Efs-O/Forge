/** Plain-text status and transcript views for the agent bus. */

import type { ForgeExchange } from '../sidebar/sessionProjections';
import { describeBudget, describeWork } from '../remote/RemoteSessionCommands';
import { MAX_VIEW_COUNT, renderExchange } from '../remote/RemoteTranscriptView';
import { clip, MAX_TOOL_NAME_CHARS, type TurnSnapshot } from './busTurnWatch';

export interface BusStatusInput {
  conversation: {
    id: string;
    title: string;
    activeModel?: string | null | undefined;
    requestCount?: number | undefined;
    toolCallCount?: number | undefined;
    compactCount?: number | undefined;
    activeMs?: number | undefined;
  };
  streaming: boolean;
  queuedFromSender: number;
  budget: { used: number; max: number } | undefined;
  turn: TurnSnapshot | undefined;
  watchAttached: boolean;
  now: number;
  waiting?: { kind: 'approval'; toolName: string; ownerOnly: boolean } | { kind: 'question' };
}

export function renderBusStatus(input: BusStatusInput): string {
  const { conversation, turn, streaming, now } = input;
  const state =
    streaming && turn?.state === 'running'
      ? `busy · turn running ${dur(now - turn.startedAt)} · last activity ${dur(now - turn.lastEventAt)} ago`
      : streaming && !input.watchAttached
        ? 'busy · live detail unavailable (the watcher is not attached yet)'
        : streaming
          ? 'busy · this turn started before the watcher attached; no live detail'
          : turn?.state === 'ended'
            ? `idle · ${turn.endedOutcome === 'stopped' ? 'last turn was stopped' : `last turn ended ${turn.endedOutcome === 'ok' ? 'ok' : 'with an error'}`} ${dur(now - (turn.endedAt ?? now))} ago after ${dur((turn.endedAt ?? now) - turn.startedAt)}, ${turn.toolCalls} tool call(s)`
            : 'idle';
  const lines = [
    `Chat: ${conversation.title} · ${conversation.id}`,
    `State: ${state}`,
    `Model: ${conversation.activeModel ?? 'default'}`,
  ];
  if (streaming && turn?.state === 'running') {
    lines.push(
      `Now: ${turn.phase ?? 'working'} · last tool ${turn.lastTool ?? 'none yet'} · ${turn.toolCalls} tool call(s) this turn`,
    );
  }
  if (input.waiting?.kind === 'approval') {
    const toolName = clip(input.waiting.toolName, MAX_TOOL_NAME_CHARS);
    lines.push(
      input.waiting.ownerOnly
        ? `Waiting: an approval card for ${toolName} is open in this chat; only the owner can answer it`
        : `Waiting: an approval card for ${toolName} is open in this chat`,
    );
  } else if (input.waiting?.kind === 'question') {
    lines.push('Waiting: a question (ask_user) is open in this chat');
  }
  if (streaming && turn?.lastNarration) lines.push(`Said: ${turn.lastNarration}`);
  if (turn && turn.warnings.length > 0) lines.push(`Warnings: ${turn.warnings.join(' | ')}`);
  lines.push(
    `Context: ${describeBudget(input.budget)}`,
    `Queued from you: ${input.queuedFromSender}`,
    describeWork(conversation),
  );
  return lines.join('\n');
}

function dur(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * A sender whose messages are accepted but have not started and have no open
 * chat to report yet: a `--new` message opens its own chat when it runs, and a
 * `--to` chat the user has since closed is restored then too, so there is
 * nothing to show before then. `status` answers 200 with this instead of the
 * 404 that `forge.sh wait` reads as a dead endpoint and exits on (audit F3).
 * `State:` describes the queue, not a chat's turn: `wait` completes on
 * `State: idle` with `Queued from you: 0`, and neither is true here.
 */
export function renderQueuedStatus(queued: number): string {
  return [
    'Chat: none yet — your message is accepted and has not started',
    'State: queued',
    `Queued from you: ${queued}`,
  ].join('\n');
}

export function renderBusView(
  exchanges: readonly ForgeExchange[],
  options: { clamped: boolean; streaming: boolean },
): string {
  const notes = [
    ...(options.clamped ? [`Note: showing the last ${MAX_VIEW_COUNT}, the maximum.`] : []),
    ...(options.streaming ? ['Note: a turn is running; the last entry may be partial.'] : []),
  ];
  const body =
    exchanges.length === 0
      ? 'No answers in this chat yet.'
      : exchanges
          .map((exchange, index) => renderExchange(exchange, index + 1, exchanges.length))
          .join('\n\n---\n\n');
  return notes.length > 0 ? `${notes.join('\n')}\n\n${body}` : body;
}
