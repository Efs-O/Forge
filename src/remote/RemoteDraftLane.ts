import { describeError } from '../util/describeError';
import { keepTail, sanitize } from './remoteProgressText';
import type { RichDraftTransport } from './telegramRichDraft';

/**
 * How often streamed words reach a draft preview. Faster than the 1.5s edit
 * cadence because a draft is what the streaming *is*; Telegram animates the
 * difference between two updates, so a second apart reads as continuous.
 */
export const DRAFT_STREAM_INTERVAL_MS = 1_000;

/**
 * The streamed text a preview keeps. The render keeps the tail, so a long
 * answer scrolls inside the preview; the whole answer is always in the final
 * message, which this buffer never feeds.
 */
export const MAX_STREAM_CHARS = 3_000;

/** Append one streamed delta to a preview's buffer, scrubbed and bounded. */
export function appendStream(buffer: string, delta: string): string {
  const clean = sanitize(delta);
  return clean ? keepTail(buffer + clean, MAX_STREAM_CHARS) : buffer;
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

/**
 * Send the persistent status that replaces a turn's preview; resolves to its
 * message id, or undefined when the send failed.
 *
 * The preview is a 30-second thing and Telegram keeps nothing unless the bot
 * sends a message, so this is what leaves the turn's status in the chat. It
 * carries status only, never the answer, which is always its own message.
 * A failure is reported in its own words rather than as a failed *update*: a
 * failed update costs one stale line, a failed finalize leaves no status at all.
 */
export async function finalizeDraftStatus(
  rich: RichDraftTransport,
  chatId: string,
  text: string,
  signal: AbortSignal,
  onError?: (message: string) => void,
): Promise<string | undefined> {
  try {
    return await rich.finalizeStatus(chatId, text, { signal });
  } catch (err) {
    onError?.(`Forge remote status could not be finalized: ${describeError(err)}`);
    return undefined;
  }
}
