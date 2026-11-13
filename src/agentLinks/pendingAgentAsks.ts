/**
 * Asks started by `ask_agent` that have not replied yet. The tool returns at
 * once and the reply arrives later as a chat message, so this registry queues
 * distinct asks per (chat, agent), refuses repeats, supports Stop and close
 * cancellation, and supplies the end-of-turn notice. Memory only: a restart kills
 * the CLI children with it, and nothing is left to deliver.
 */
import { randomUUID } from 'crypto';
import { agentDisplayName, type AgentKind } from './chatAgentLinks';
import type { AskAgentRequest } from './askAgentService';

/** Starts an `ask_agent` ask that replies into its chat later; resolves to the tool result. */
/**
 * How long a background ask may run before it settles as timed out (owner,
 * 2026-10-28). Longer than the blocking paths' 10 minutes: nothing waits on
 * it, and an audit routinely takes 5-15 minutes. Stop cancels it sooner.
 */
export const BACKGROUND_ASK_LIMIT_MS = 30 * 60_000;

export type StartAgentAsk = (conversationId: string, request: AskAgentRequest) => Promise<string>;

export interface PendingAgentAsk {
  exchangeId: string;
  conversationId: string;
  agent: AgentKind;
  message: string;
  request: AskAgentRequest;
  targetIdentity?: string;
  startedAt: number;
  controller: AbortController;
  queuedAfterExchangeId?: string;
}

const pending = new Map<string, PendingAgentAsk[]>();

const keyOf = (conversationId: string, agent: AgentKind): string => `${conversationId}\0${agent}`;

export function newExchangeId(): string {
  return randomUUID().slice(0, 8);
}

export function pendingAgentAsksForAgent(
  conversationId: string,
  agent: AgentKind,
): PendingAgentAsk[] {
  return [...(pending.get(keyOf(conversationId, agent)) ?? [])];
}

export function addPendingAgentAsk(entry: PendingAgentAsk): void {
  const key = keyOf(entry.conversationId, entry.agent);
  const queue = pending.get(key) ?? [];
  queue.push(entry);
  pending.set(key, queue);
}

/** Removes the entry only while it is still this exchange's. */
export function removePendingAgentAsk(entry: PendingAgentAsk): void {
  const key = keyOf(entry.conversationId, entry.agent);
  const queue = pending.get(key);
  if (!queue) return;
  const index = queue.indexOf(entry);
  if (index >= 0) queue.splice(index, 1);
  if (queue.length === 0) pending.delete(key);
}

export function pendingAgentAsksFor(conversationId: string): PendingAgentAsk[] {
  return [...pending.values()].flat().filter((entry) => entry.conversationId === conversationId);
}

/** Aborts every pending ask of the chat; their runs remove themselves on settle. */
export function cancelPendingAgentAsks(conversationId: string): number {
  const entries = pendingAgentAsksFor(conversationId);
  for (const entry of entries) entry.controller.abort();
  return entries.length;
}

export function formatAskAge(startedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000);
  return minutes < 1 ? 'under a minute' : `${minutes} min`;
}

/** The end-of-turn notice line, or undefined when no ask is pending. */
export function pendingAgentAsksNotice(
  conversationId: string,
  now = Date.now(),
): string | undefined {
  const entries = pendingAgentAsksFor(conversationId);
  if (entries.length === 0) return undefined;
  return entries
    .map((entry) =>
      entry.queuedAfterExchangeId
        ? `Waiting on ${agentDisplayName(entry.agent)} (exchange ${entry.exchangeId}, queued after ${entry.queuedAfterExchangeId}); its reply will start a new turn.`
        : `Waiting on ${agentDisplayName(entry.agent)} (exchange ${entry.exchangeId}, ${formatAskAge(entry.startedAt, now)}); its reply will start a new turn.`,
    )
    .join('\n');
}
