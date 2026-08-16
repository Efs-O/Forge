/**
 * Assembling a Codex turn's assistant text from app-server notifications.
 *
 * Split out of `CodexAppServerSession`: the protocol delivers the same reply
 * twice in some builds — streamed as deltas, then again whole in
 * `item/completed` — so this is where de-duplication lives.
 */

import type { CliAgentRunResult } from './types';
import type { CliAgentSessionSendOptions } from './CliAgentSession';

export interface ActiveTurn {
  text: string;
  /** Text already received per app-server agent-message item. */
  readonly agentMessageText: Map<string, string>;
  sawCommandExecution: boolean;
  turnId?: string;
  interrupted: boolean;
  interruptSent: boolean;
  resolve(result: CliAgentRunResult): void;
  signal?: AbortSignal;
  onAbort(): void;
  onEvent?: CliAgentSessionSendOptions['onEvent'];
}

export function appendAgentText(
  active: ActiveTurn,
  itemId: string | undefined,
  text: string,
): void {
  if (!text) return;
  active.text += text;
  if (itemId) {
    active.agentMessageText.set(itemId, `${active.agentMessageText.get(itemId) ?? ''}${text}`);
  }
  active.onEvent?.({ kind: 'text', text });
}

/**
 * Recent Codex app-server versions may deliver an assistant's final message
 * only in item/completed, after the command item. Capture its unstreamed
 * suffix without duplicating text that arrived through delta notifications.
 */
export function captureCompletedAgentMessage(
  active: ActiveTurn,
  params: Record<string, unknown>,
): void {
  const item = params['item'];
  const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
  if (!record) return;
  captureAgentMessage(active, record);
}

export function captureAgentMessage(active: ActiveTurn, record: Record<string, unknown>): void {
  if (record['type'] !== 'agentMessage' || typeof record['text'] !== 'string') return;
  const itemId = typeof record['id'] === 'string' ? record['id'] : undefined;
  const completed = record['text'];
  const streamed = itemId ? active.agentMessageText.get(itemId) : undefined;
  if (streamed !== undefined && completed.startsWith(streamed)) {
    appendAgentText(active, itemId, completed.slice(streamed.length));
    return;
  }
  // Some app-server builds omit or change the delta's item id. Do not treat
  // an empty per-item buffer as a full-prefix match: completed.startsWith('')
  // is always true and would append the already streamed reply a second time.
  if (active.text.includes(completed)) return;
  const overlap = trailingPrefixOverlap(active.text, completed);
  appendAgentText(active, itemId, completed.slice(overlap));
}

/** Length of the longest suffix of `existing` that is a prefix of `next`. */
export function trailingPrefixOverlap(existing: string, next: string): number {
  const limit = Math.min(existing.length, next.length);
  for (let length = limit; length > 0; length -= 1) {
    if (existing.endsWith(next.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Some app-server builds omit item/completed for the final message after a
 * command. The completed turn history is the authoritative fallback.
 */
export function captureTerminalTurnMessages(active: ActiveTurn, result: unknown): void {
  const root =
    result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
  const thread = root?.['thread'];
  const threadRecord =
    thread && typeof thread === 'object' ? (thread as Record<string, unknown>) : undefined;
  const turns = threadRecord?.['turns'];
  if (!Array.isArray(turns)) return;
  const turn = turns.find(
    (value) =>
      value &&
      typeof value === 'object' &&
      (value as Record<string, unknown>)['id'] === active.turnId,
  ) as Record<string, unknown> | undefined;
  const items = turn?.['items'];
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    captureAgentMessage(active, item as Record<string, unknown>);
  }
}
