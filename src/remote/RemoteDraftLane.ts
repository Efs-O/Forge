import { sanitize } from './remoteProgressText';
import { describeError } from '../util/describeError';
import type { RemoteDraftRegistry } from './RemoteDraftRegistry';
import type { RichDraftTransport } from './telegramRichDraft';

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

export interface WordsDraftDeps {
  rich: RichDraftTransport;
  chatId: string;
  conversationId: string;
  signal: AbortSignal;
  /** Live draft previews, so Telegram's Stop on this one finds the turn. */
  drafts?: RemoteDraftRegistry | undefined;
  /** False once the owning turn closed or was replaced. */
  live: () => boolean;
  canDeliver: () => Promise<boolean>;
  maxChars: () => number;
  streamIntervalMs: number;
  /** After this long without a send the preview is treated as gone. */
  lifetimeMs: number;
  report: (err: unknown) => void;
}

/**
 * One turn's words preview: a rich draft carrying only the model's streamed
 * words, opened on the first word and never carrying status.
 *
 * A status in a draft is re-typed letter by letter on every change, which is
 * what made "Forge: working…" crawl, so the status stays in the plain bubble
 * and this owns nothing else. Every update reuses one draft id so Telegram
 * animates only the appended words; Telegram's Stop update names that id.
 *
 * There is no keep-alive. Re-sending unchanged words to hold a preview open
 * made Telegram re-type them on every beat, so a slow step replayed the same
 * sentence twice (2026-10-05, a 59 s cold prefill after `load_tool_group`).
 * A preview quiet past its lifetime is let go, and the next words open a new
 * one holding only themselves.
 */
export class RemoteWordsDraft {
  /** `off` once the transport refused a draft: the turn streams nothing more. */
  private phase: 'none' | 'opening' | 'open' | 'off' = 'none';
  private draftId: number | undefined;
  /** The turn's streamed words, append-only, so Telegram never re-types them. */
  private words = '';
  /** What the preview last showed. */
  private shown = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When the open preview was last sent, to tell when Telegram dropped it. */
  private sentAt = 0;
  private readonly lane: RemoteDraftLane;

  constructor(private readonly deps: WordsDraftDeps) {
    this.lane = new RemoteDraftLane(() => this.send(), deps.report);
  }

  /** Whether a preview was opened, and so may be registered for Stop. */
  get opened(): boolean {
    return this.draftId !== undefined;
  }

  /** Adds streamed words; false once this turn streams nothing more. */
  append(delta: string): boolean {
    if (this.phase === 'off') return false;
    if (this.phase === 'open' && Date.now() - this.sentAt > this.deps.lifetimeMs) {
      // The old preview is gone; starting from its words would re-type them.
      this.phase = 'none';
      this.draftId = undefined;
      this.words = '';
      this.shown = '';
    }
    const next = appendStream(this.words, delta);
    if (next === this.words || this.timer) {
      this.words = next;
      return true;
    }
    this.words = next;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.text() !== this.shown) this.lane.request();
    }, this.deps.streamIntervalMs);
    return true;
  }

  /** Stops the timers now; settles when no send is in flight. */
  close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.lane.idle();
  }

  private text(): string {
    return this.words.trim().slice(0, this.deps.maxChars());
  }

  /**
   * One preview send, rendered when it is actually sent so a coalesced request
   * carries the newest words. The first send opens the draft.
   */
  private async send(): Promise<void> {
    const { rich, chatId, conversationId, signal, drafts } = this.deps;
    if (this.phase === 'off' || this.phase === 'opening') return;
    if (signal.aborted || !this.deps.live()) return;
    const text = this.text();
    if (!text) return;
    if (!(await this.deps.canDeliver())) return;
    if (this.draftId !== undefined) {
      await rich.updateDraft(chatId, this.draftId, text, { signal });
      this.shown = text;
      this.sentAt = Date.now();
      return;
    }
    // Read before the await: an unpair during the open must not leave this
    // preview registered as a Stop path for the revoked pairing.
    const epoch = drafts?.epoch();
    this.phase = 'opening';
    const outcome = await rich
      .beginDraft(chatId, text, { signal })
      .catch((err: unknown) => ({ kind: 'unknown' as const, error: describeError(err) }));
    if (outcome.kind !== 'open') {
      // Refused or unknown: stream nothing more this turn rather than risk a
      // second preview. The bubble and the narrations still report the turn.
      this.phase = 'off';
      if (outcome.kind === 'unknown') this.deps.report(new Error(outcome.error));
      return;
    }
    this.phase = 'open';
    this.draftId = outcome.draftId;
    this.shown = text;
    this.sentAt = Date.now();
    if (!this.deps.live()) return;
    // Joins this turn's earlier previews: any of them still on screen may Stop it.
    if (epoch === undefined || drafts?.isCurrent(epoch)) {
      drafts?.register({ chatId, conversationId, draftId: outcome.draftId });
    }
  }
}
