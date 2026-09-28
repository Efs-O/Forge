import { isTerminal, type ExchangeState } from './deliveryState';

/**
 * The bounded user-facing notification policy for agent-mesh board events
 * (COPILOT_AGENT_MESH_PLAN P3 / A11).
 *
 * Pure: it decides whether a board event is a user-facing notification and
 * phrases it. It creates no delivery path, no persistence, and no networking —
 * the wiring layer (`agentMeshSetup`) owns delivery through the single
 * host-activity path. This module only answers "what, if anything, does the
 * user hear about this event, and what do we call it?"
 *
 * Only the terminal states the plan names as user-facing notify: completion,
 * failure/cancellation, crash, recovery, context-loss, and idle-TTL timeout.
 * The non-terminal states (created/accepted/observed/started) never notify —
 * `accepted` means queued, not processed, and the plan forbids claiming
 * otherwise.
 *
 * The text names the alias and the exchange/state. It never includes the
 * prompt, the message body, or any secret: a `state` event's detail can carry
 * the turn's final answer or an error, so only `notice` events (whose detail
 * is a system reason) contribute it.
 */

export interface MeshBoardEvent {
  exchangeId: string;
  from: string;
  to?: string;
  type: string;
  state: ExchangeState;
  detail?: string;
}

export interface MeshScope {
  conversation?: string;
}

export interface MeshUserNotification {
  /** Ready to send through the host-activity path. */
  text: string;
  /** Conversation scope so the bound chat receives it; absent = window scope. */
  conversationId?: string;
}

export function meshEventNotification(
  event: MeshBoardEvent,
  scope: MeshScope,
): MeshUserNotification | undefined {
  if (!isTerminal(event.state)) return undefined;
  const alias = (event.to ?? event.from).toLowerCase();
  // Only a `notice` event's detail is a system reason safe to surface; a
  // `state` event's detail can be the turn's answer or an error, so it is
  // never included.
  const detail = event.type === 'notice' && event.detail ? event.detail : undefined;
  const text = `[agent mesh ${event.exchangeId}] ${alias} ${event.state}${
    detail ? ` — ${detail}` : ''
  }`;
  return {
    text,
    ...(scope.conversation ? { conversationId: scope.conversation } : {}),
  };
}
