/** Eligibility and arrival notifications for messages claimed between tool rounds. */

import type { InboxMessageOptions } from './agentInbox';

export interface RunningTurnPolicy {
  unattended: boolean;
  jobId?: string;
}

export interface ClaimedMidTurnMessage {
  content: string;
  options?: InboxMessageOptions;
}

export interface MidTurnQueueItem {
  id?: string;
  from?: string;
  options?: InboxMessageOptions;
  steer?: boolean;
  hold?: boolean;
}

interface MidTurnArrivalListener {
  targetOf: (options?: InboxMessageOptions) => string;
  runningTurn: () => RunningTurnPolicy;
  callback: () => void;
}

export function isClaimableMidTurn<T extends MidTurnQueueItem>(
  item: T,
  conversationId: string,
  targetOf: (options?: InboxMessageOptions) => string,
  runningTurn: RunningTurnPolicy,
  optionsFor: (item: T) => InboxMessageOptions | undefined,
): boolean {
  if (item.steer || item.hold || item.options?.newChat || item.options?.model) return false;
  const options = optionsFor(item);
  if (targetOf(options) !== conversationId) return false;
  return !options?.unattended || (runningTurn.unattended && options.jobId === runningTurn.jobId);
}

export class AgentInboxMidTurn {
  private readonly listeners = new Map<string, Set<MidTurnArrivalListener>>();

  add(
    conversationId: string,
    targetOf: (options?: InboxMessageOptions) => string,
    runningTurn: () => RunningTurnPolicy,
    callback: () => void,
    queued: readonly MidTurnQueueItem[],
    optionsFor: (item: MidTurnQueueItem) => InboxMessageOptions | undefined,
  ): () => void {
    const listener = { targetOf, runningTurn, callback };
    const listeners = this.listeners.get(conversationId) ?? new Set<MidTurnArrivalListener>();
    listeners.add(listener);
    this.listeners.set(conversationId, listeners);
    if (
      queued.some((item) =>
        isClaimableMidTurn(item, conversationId, targetOf, runningTurn(), optionsFor),
      )
    ) {
      callback();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(conversationId);
    };
  }

  release<T extends MidTurnQueueItem>(
    queued: T[],
    id: string,
    optionsFor: (item: T) => InboxMessageOptions | undefined,
    scheduleScan: () => void,
  ): boolean {
    const item = queued.find((candidate) => candidate.id === id);
    if (!item) return false;
    if (item.hold) {
      delete item.hold;
      this.signal(item, optionsFor);
      scheduleScan();
    }
    return true;
  }

  claim<T extends MidTurnQueueItem>(
    queued: T[],
    conversationId: string,
    targetOf: (options?: InboxMessageOptions) => string,
    runningTurn: RunningTurnPolicy,
    promptFor: (item: T) => string,
    optionsFor: (item: T) => InboxMessageOptions | undefined,
  ): ClaimedMidTurnMessage[] {
    const claimed: ClaimedMidTurnMessage[] = [];
    for (let i = 0; i < queued.length; i++) {
      const item = queued[i] as T;
      if (!isClaimableMidTurn(item, conversationId, targetOf, runningTurn, optionsFor)) continue;
      const options = optionsFor(item);
      claimed.push({ content: promptFor(item), ...(options ? { options } : {}) });
      queued.splice(i--, 1);
    }
    return claimed;
  }

  signal<T extends MidTurnQueueItem>(
    item: T,
    optionsFor: (item: T) => InboxMessageOptions | undefined,
  ): void {
    for (const [conversationId, listeners] of this.listeners) {
      for (const listener of listeners) {
        if (
          isClaimableMidTurn(
            item,
            conversationId,
            listener.targetOf,
            listener.runningTurn(),
            optionsFor,
          )
        ) {
          listener.callback();
        }
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
