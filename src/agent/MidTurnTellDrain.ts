/**
 * The single composer of mid-turn tells. Every door (the sidebar inbox and the
 * remote queue) registers a source here; at a tool-round gap `drain` runs them
 * in registration order, merges their messages, and returns one settle step that
 * finishes each source's claim in order.
 *
 * Sources are keyed so a re-registration (config reload) replaces rather than
 * duplicates. A failing later source cannot discard messages an earlier source
 * already drained: each source is awaited independently, and the first error is
 * preserved and rethrown from the settle step after the earlier settles have run.
 */

import type { MidTurnDrainResult } from './MidTurnInbox';

export type MidTurnTellSource = (conversationId: string) => Promise<MidTurnDrainResult>;
export type MidTurnTellSubscription = (conversationId: string, callback: () => void) => () => void;

interface RegisteredTellSource {
  drain: MidTurnTellSource;
  subscribe?: MidTurnTellSubscription;
}

interface ArrivalSubscription {
  callback: () => void;
  sources: Map<string, () => void>;
  active: boolean;
}

export class MidTurnTellDrain {
  private readonly sources = new Map<string, RegisteredTellSource>();
  private readonly arrivals = new Map<string, Set<ArrivalSubscription>>();

  /** Register (or replace) a named source. Registration order is drain order. */
  registerSource(
    name: string,
    drain: MidTurnTellSource,
    subscribe?: MidTurnTellSubscription,
  ): void {
    this.sources.set(name, { drain, ...(subscribe ? { subscribe } : {}) });
    for (const [conversationId, subscriptions] of this.arrivals) {
      for (const arrival of subscriptions) this.subscribeSource(name, conversationId, arrival);
    }
  }

  /** Subscribe to every source, including sources registered later. */
  onArrived(conversationId: string, callback: () => void): () => void {
    const arrival: ArrivalSubscription = {
      callback: () => {
        if (arrival.active) callback();
      },
      sources: new Map(),
      active: true,
    };
    const subscriptions = this.arrivals.get(conversationId) ?? new Set<ArrivalSubscription>();
    subscriptions.add(arrival);
    this.arrivals.set(conversationId, subscriptions);
    for (const name of this.sources.keys()) this.subscribeSource(name, conversationId, arrival);
    return () => {
      arrival.active = false;
      for (const unsubscribe of arrival.sources.values()) unsubscribe();
      arrival.sources.clear();
      subscriptions.delete(arrival);
      if (subscriptions.size === 0) this.arrivals.delete(conversationId);
    };
  }

  async drain(conversationId: string): Promise<MidTurnDrainResult> {
    const results: MidTurnDrainResult[] = [];
    let firstError: unknown;
    let hasSourceError = false;
    for (const source of this.sources.values()) {
      try {
        results.push(await source.drain(conversationId));
      } catch (err) {
        // A failing source yields nothing, but messages already drained by the
        // earlier sources still reach the turn.
        results.push({ messages: [] });
        if (!hasSourceError) {
          firstError = err;
          hasSourceError = true;
        }
      }
    }
    const messages = results.flatMap((result) => result.messages);
    const settles = results
      .map((result) => result.settle)
      .filter((step): step is () => Promise<void> => step !== undefined);
    if (settles.length === 0 && !hasSourceError) return { messages };
    return {
      messages,
      settle: async () => {
        let settlementError: unknown;
        let hasSettlementError = false;
        for (const step of settles) {
          try {
            await step();
          } catch (err) {
            if (!hasSettlementError) {
              settlementError = err;
              hasSettlementError = true;
            }
          }
        }
        if (hasSourceError) throw firstError;
        if (hasSettlementError) throw settlementError;
      },
    };
  }

  private subscribeSource(
    name: string,
    conversationId: string,
    arrival: ArrivalSubscription,
  ): void {
    if (arrival.sources.has(name)) arrival.sources.get(name)?.();
    const source = this.sources.get(name);
    if (!source?.subscribe) {
      arrival.sources.delete(name);
      return;
    }
    const unsubscribe = source.subscribe(conversationId, arrival.callback);
    if (arrival.active) arrival.sources.set(name, unsubscribe);
    else unsubscribe();
  }
}
