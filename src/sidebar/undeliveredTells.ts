/**
 * What becomes of the tells a turn never read. `SendPipeline` applies this at
 * the in-chain stop and again after the chain releases; the rule lives here so
 * the two sites cannot drift apart.
 */

import type { MidTurnTell } from '../agent/MidTurnInbox';

export interface TellBatch {
  text: string;
  internal: boolean;
  createdAt?: number;
}

/** Consecutive tells of the same kind travel as one prompt. */
export function groupTellBatches(tells: readonly MidTurnTell[]): TellBatch[] {
  const batches: TellBatch[] = [];
  for (const tell of tells) {
    const internal = tell.internal === true;
    const current = batches[batches.length - 1];
    if (current?.internal === internal) current.text += `\n\n${tell.text}`;
    else
      batches.push({
        text: tell.text,
        internal,
        ...(tell.createdAt !== undefined ? { createdAt: tell.createdAt } : {}),
      });
  }
  return batches;
}

/** The user's own words among `batches`, for the input box; a Forge notice is not theirs to edit. */
export function inputTextOf(batches: readonly TellBatch[]): string | undefined {
  const text = batches
    .filter((batch) => !batch.internal)
    .map((batch) => batch.text)
    .join('\n\n');
  return text || undefined;
}

/**
 * A stopped turn hands its unread tells back to the input box, unless the
 * user pressed "Send now" on one: that is what interrupted the turn, so they
 * run next. A Stop pressed instead ends the chain `cancelled`, and Stop wins.
 */
export function runsAfterStop(kind: string, tells: readonly MidTurnTell[]): boolean {
  return kind === 'interrupted' && tells.some((tell) => tell.sendNow === true);
}
