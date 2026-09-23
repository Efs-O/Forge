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

export class MidTurnTellDrain {
  private readonly sources = new Map<string, MidTurnTellSource>();

  /** Register (or replace) a named source. Registration order is drain order. */
  registerSource(name: string, source: MidTurnTellSource): void {
    this.sources.set(name, source);
  }

  async drain(conversationId: string): Promise<MidTurnDrainResult> {
    const results: MidTurnDrainResult[] = [];
    let firstError: unknown;
    for (const source of this.sources.values()) {
      try {
        results.push(await source(conversationId));
      } catch (err) {
        // A failing source yields nothing, but messages already drained by the
        // earlier sources still reach the turn.
        results.push({ messages: [] });
        firstError ??= err;
      }
    }
    const messages = results.flatMap((result) => result.messages);
    const settles = results
      .map((result) => result.settle)
      .filter((step): step is () => Promise<void> => step !== undefined);
    if (settles.length === 0 && firstError === undefined) return { messages };
    return {
      messages,
      settle: async () => {
        for (const step of settles) await step();
        if (firstError !== undefined) throw firstError;
      },
    };
  }
}
