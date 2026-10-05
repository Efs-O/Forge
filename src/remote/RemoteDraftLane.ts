import { sanitize } from './remoteProgressText';

/**
 * How often streamed words reach a draft preview. Faster than the 1.5s edit
 * cadence because a draft is what the streaming *is*; Telegram animates the
 * difference between two updates, so a second apart reads as continuous.
 */
export const DRAFT_STREAM_INTERVAL_MS = 1_000;

/**
 * How many streamed characters a preview holds before it starts over.
 * Telegram re-types a draft from its first changed character, so the words
 * only ever append; when full they restart from the newest delta (one short
 * re-type) rather than dropping their head, which would re-type the whole text
 * on every update. The whole answer is always in the final message.
 */
export const MAX_STREAM_CHARS = 3_000;

/** Append one streamed delta to a preview's words, scrubbed and bounded. */
export function appendStream(buffer: string, delta: string): string {
  const clean = sanitize(delta);
  if (!clean) return buffer;
  const next = buffer + clean;
  return next.length > MAX_STREAM_CHARS ? clean.trimStart().slice(-MAX_STREAM_CHARS) : next;
}

/**
 * One draft preview's send lane: at most one call in flight, and the newest
 * state wins.
 *
 * Deliberately separate from `RemoteAgentProgress`'s `tail`, which carries the
 * narrations and warnings. A preview is replaceable — the next update renders
 * the whole state again — so it may be coalesced or skipped, while a narration
 * is a real message that must not wait behind one. Chaining both on one promise
 * is what let a throttled heartbeat hold a turn's narrations back and release
 * them in one burst.
 *
 * `send` renders at call time rather than taking text, so a request made while
 * another is in flight costs one extra call carrying the latest state, not one
 * call per request.
 */
export class RemoteDraftLane {
  private inFlight: Promise<void> | undefined;
  private pending = false;

  constructor(
    private readonly send: () => Promise<void>,
    private readonly report: (err: unknown) => void,
  ) {}

  request(): void {
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.inFlight = this.run();
  }

  /** Settles once nothing is in flight; `finish` waits on it before finalizing. */
  idle(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  private async run(): Promise<void> {
    do {
      this.pending = false;
      try {
        await this.send();
      } catch (err) {
        this.report(err);
      }
    } while (this.pending);
    this.inFlight = undefined;
  }
}
