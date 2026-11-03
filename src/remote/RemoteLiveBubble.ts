import type { RemoteChannel } from './types';
import { abortableSleep } from '../util/abortableSleep';

/** Room the status footer may take; the words split into a new bubble before it. */
const MAX_FOOTER_CHARS = 700;

type BubbleChannel = Pick<RemoteChannel, 'sendProgress' | 'editMessage' | 'deleteMessage'>;

export interface LiveBubbleDeps {
  channel: BubbleChannel;
  chatId: string;
  signal: AbortSignal;
  canDeliver: () => Promise<boolean>;
  maxChars: () => number;
  /** The status footer as it reads now, rendered at send time. */
  footer: (maximum: number) => string;
  /** Minimum gap between two refreshes: Telegram allows ~1 edit/s per chat. */
  intervalMs: number;
  report: (err: unknown) => void;
}

interface Bubble {
  /** Undefined until the send that creates it lands. */
  id?: string;
  /** The words this bubble carries, without the footer. */
  text: string;
  /** What the chat last showed for it, footer included. */
  shown?: string;
  /**
   * Whether that message currently shows the inline Stop keyboard.
   *
   * Telegram drops the keyboard on any edit that does not re-attach it, so the
   * text alone does not say what is on screen: a suspended footer has the same
   * words as a settled one and a different keyboard.
   */
  stopShown?: boolean;
  /** Deleted from the chat: nothing left to edit, and nothing to delete again. */
  gone?: boolean;
}

/**
 * Where the current text block is.
 *
 * `streaming`: words are arriving for the newest bubble. `finished`: a tool
 * call ended the block. `narrated`: the loop handed over the finished
 * paragraph. In either finished state the next word starts a new bubble.
 */
type BlockState = 'none' | 'streaming' | 'finished' | 'narrated';

/**
 * A turn's chat bubbles: the agent's words, one bubble per text block, with the
 * status footer and any inline Stop button only on the newest.
 *
 * Telegram never moves a message, so a separate status message was left
 * stranded above every bubble sent after it. The footer instead travels with
 * the newest bubble: when a new bubble starts, the old one is edited to its
 * words alone, which also takes its keyboard away.
 *
 * Every send is rendered from a bubble's own fields at send time, and the
 * target message id is read off that same object. A block boundary replaces
 * the current bubble object rather than clearing it, so an update composed for
 * the old bubble can only ever land on the old message: there is no shared
 * buffer for the next bubble to inherit.
 *
 * A question board or an approval card stops the turn while the owner reads it.
 * `suspend()` takes the working line off the newest bubble and draws nothing
 * until `resume()` reopens it below the board, because Telegram never moves a
 * message: a footer left where it was would sit above the buttons, out of
 * sight, and an edit in place would put it back under them while the owner is
 * still answering.
 */
export class RemoteLiveBubble {
  private current: Bubble;
  /** Bubbles that left the bottom of the chat and still owe their final edit. */
  private readonly retiring: Bubble[] = [];
  /**
   * Bubbles split off the block that is still streaming. If that block turns
   * out to be the final answer, the answer arrives as its own message, so these
   * are deleted rather than left as a second copy of it.
   */
  private overflow: Bubble[] = [];
  private block: BlockState = 'none';
  /** Whether the streaming block spans more than the current bubble. */
  private split = false;
  /** True while the chat waits on the owner: the working line is off screen. */
  private suspended = false;
  /** The pass that took the line away has landed. */
  private footerHidden = false;
  /** Every message this turn has used, so Stop works from any of them. */
  private readonly ids = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private pending = false;
  private closed = false;

  constructor(
    private readonly deps: LiveBubbleDeps,
    firstMessageId: string,
  ) {
    this.current = { id: firstMessageId, text: '' };
    this.ids.add(firstMessageId);
  }

  owns(messageId: string): boolean {
    return this.ids.has(messageId);
  }

  /** True while words are arriving whose finished paragraph has not come yet. */
  get streaming(): boolean {
    return this.block === 'streaming';
  }

  /** Streamed words of the current text block. */
  append(words: string): void {
    if (this.closed || !words) return;
    if (this.block !== 'streaming') {
      if (this.current.text.trim()) this.startBubble();
      this.block = 'streaming';
      this.split = false;
      this.overflow = [];
    }
    this.current.text += words;
    this.fit();
    this.request();
  }

  /**
   * The block's finished paragraph. When it streamed, it replaces the streamed
   * words (the loop's text is authoritative); when nothing streamed for it, as
   * with a CLI mirror, it becomes a bubble of its own.
   */
  narrate(text: string): void {
    if (this.closed || !text) return;
    if (this.block === 'streaming') {
      if (!this.split) this.current.text = text;
    } else {
      if (this.current.text.trim()) this.startBubble();
      this.current.text = text;
      this.split = false;
    }
    this.block = 'narrated';
    this.overflow = [];
    this.fit();
    this.request();
  }

  /** A tool call ends the block; the next word belongs to a new bubble. */
  endBlock(): void {
    if (this.block !== 'streaming') return;
    this.block = 'finished';
    this.overflow = [];
  }

  /**
   * Something else was sent to the chat (a warning, an image) and now sits
   * below the newest bubble. Its words stay where they are; the footer moves
   * to a fresh bubble under the new message.
   */
  strand(): void {
    if (this.closed || this.current.id === undefined) return;
    this.relocate();
    this.request();
  }

  /**
   * Takes the working line away for as long as the chat waits on the owner: a
   * question board or an approval card has just been sent, and a footer left on
   * the newest bubble would sit above the buttons, out of sight.
   *
   * A bubble carrying words is edited to those words alone and keeps its Stop
   * button, so "Send now" still works while the owner is answering. A bubble
   * carrying only the footer is deleted: Telegram rejects an empty message, and
   * a status-only bubble is already what `settle()` treats as nothing worth
   * keeping once the footer has moved on. Nothing is redrawn until `resume()`,
   * so the agent's own words, a `request()` or the clock cannot bring the line
   * back on the bubble above the board.
   */
  suspend(): void {
    // No message drawn yet means no line to hide: the next send lands below the
    // board anyway and carries the footer with it.
    if (this.closed || this.suspended || this.current.id === undefined) return;
    this.suspended = true;
    // Through kick(), never a direct send: an in-flight flush would otherwise
    // overwrite this, and the chat's ~1 edit/s throttle still applies.
    this.kick();
  }

  /**
   * Puts the working line back, below whatever the wait put on screen. Same
   * relocation as `strand()`: the bubble that carried the line stops carrying
   * it and loses its keyboard, so exactly one Stop button exists at a time, and
   * the line reopens as a fresh message at the bottom of the chat.
   */
  resume(): void {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    this.footerHidden = false;
    this.relocate();
    this.kick();
  }

  /** The footer changed; refresh it within the throttle. */
  request(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, this.deps.intervalMs);
  }

  /**
   * Ends the turn's bubbles: every footer and keyboard is removed. Returns the
   * messages left holding status only, for the caller to delete after a delay.
   *
   * `terminalText` absent means the answer is already on screen, so there is
   * nothing left to say: the working line goes with the rest of them at once,
   * instead of becoming a `Forge: completed.` the caller then deletes ten
   * seconds later — the second churn point the owner watched.
   */
  async close(terminalText?: string): Promise<string[]> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    if (this.deps.signal.aborted) return [];
    if (!(await this.deps.canDeliver())) return this.statusOnlyIds();
    if (this.block === 'streaming') {
      // An unfinished block is the final answer, which reaches the chat as its
      // own message; its words here would be a second copy.
      for (const bubble of this.overflow) {
        const queued = this.retiring.indexOf(bubble);
        if (queued >= 0) this.retiring.splice(queued, 1);
        bubble.text = '';
        await this.settle(bubble).catch((err) => this.deps.report(err));
      }
      this.current.text = '';
    }
    for (const bubble of this.retiring.splice(0)) {
      await this.settle(bubble).catch((err) => this.deps.report(err));
    }
    const last = this.current;
    if (terminalText === undefined) {
      // The answer landed, so the last bubble is either the agent's own last
      // paragraph (kept, footer off) or a working line worth nothing (deleted).
      await this.settle(last).catch((err) => this.deps.report(err));
      return [];
    }
    if (last.text.trim()) {
      await this.settle(last).catch((err) => this.deps.report(err));
      return [];
    }
    const outcome = terminalText.slice(0, this.deps.maxChars());
    if (!last.gone && last.id !== undefined && this.deps.channel.editMessage) {
      try {
        await this.deps.channel.editMessage(this.deps.chatId, last.id, outcome, {
          signal: this.deps.signal,
        });
      } catch (err) {
        this.deps.report(err);
      }
      return [last.id];
    }
    // Nothing left to edit: the working line was hidden under a question board
    // and went with the bubble that carried it. The outcome still has to reach
    // the chat, so it is sent as its own message and armed for deletion like
    // any other status line. A fresh bubble object, because the gone one must
    // not be edited or deleted a second time.
    if (!this.deps.channel.sendProgress) return [];
    const outcomeBubble: Bubble = { text: '' };
    await this.show(outcomeBubble, outcome, false).catch((err) => this.deps.report(err));
    return outcomeBubble.id === undefined ? [] : [outcomeBubble.id];
  }

  /**
   * Shows everything pending now, skipping the throttle. Called before
   * anything else is sent to the chat, so words said before an image or a
   * warning appear above it.
   */
  async flushNow(): Promise<void> {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.kick();
    await this.inFlight;
  }

  /** Stops refreshing without a final edit: the turn was replaced or disposed. */
  abandon(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private startBubble(): void {
    this.retire(this.current);
    this.current = { text: '' };
  }

  /** The footer leaves the newest bubble; it will be drawn on a new message. */
  private relocate(): void {
    const old = this.current;
    this.retire(old);
    if (this.block === 'streaming' && old.text.trim()) {
      this.overflow.push(old);
      this.split = true;
    }
    this.current = { text: '' };
  }

  private retire(bubble: Bubble): void {
    if (bubble.id === undefined && !bubble.text.trim()) return;
    this.retiring.push(bubble);
  }

  private footerRoom(): number {
    return Math.min(MAX_FOOTER_CHARS, Math.floor(this.deps.maxChars() / 2));
  }

  private statusOnlyIds(): string[] {
    return [
      ...new Set(
        [...this.retiring, this.current]
          .filter((bubble) => !bubble.gone && !bubble.text.trim() && bubble.id !== undefined)
          .map((bubble) => bubble.id!),
      ),
    ];
  }

  /** Splits the current bubble before its words and the footer outgrow a message. */
  private fit(): void {
    const room = Math.max(1, this.deps.maxChars() - this.footerRoom() - 2);
    while (this.current.text.length > room) {
      const text = this.current.text;
      const cut = cutPoint(text, room);
      const full = this.current;
      full.text = text.slice(0, cut).trimEnd();
      this.retire(full);
      if (this.block === 'streaming') this.overflow.push(full);
      this.current = { text: text.slice(cut).trimStart() };
      this.split = true;
    }
  }

  private kick(): void {
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    this.inFlight = this.run();
  }

  private async run(): Promise<void> {
    do {
      this.pending = false;
      try {
        await this.flush();
      } catch (err) {
        const wait = retryAfterMs(err);
        if (wait === undefined) {
          this.deps.report(err);
        } else {
          // Throttled: wait as told, then render the newest state, never the
          // snapshot that was refused.
          await abortableSleep(wait, this.deps.signal);
          this.pending = true;
        }
      }
    } while (this.pending && !this.closed && !this.deps.signal.aborted);
    this.inFlight = undefined;
  }

  private async flush(): Promise<void> {
    if (this.closed || this.deps.signal.aborted) return;
    if (!(await this.deps.canDeliver())) return;
    while (this.retiring.length > 0) {
      try {
        await this.settle(this.retiring[0]!);
      } catch (err) {
        if (retryAfterMs(err) !== undefined) throw err;
        this.deps.report(err);
      }
      this.retiring.shift();
    }
    if (this.suspended) {
      // The chat is waiting on the owner. Everything older than the board is
      // settled above, the working line comes off last, and nothing new is
      // sent until resume() relocates it below whatever the wait put there.
      if (!this.footerHidden) await this.hideFooter();
      return;
    }
    const bubble = this.current;
    const footer = this.deps.footer(this.footerRoom());
    const words = bubble.text.trim();
    const text = words ? `${words}\n\n${footer}` : footer;
    if (text !== bubble.shown) await this.show(bubble, text, true);
  }

  /**
   * The one pass `suspend()` waits for: the newest bubble stops carrying the
   * working line. Its words stay, and so does its Stop button — an edit that
   * does not re-attach the keyboard takes it away, and "Send now" has to keep
   * working while a question is on screen.
   */
  private async hideFooter(): Promise<void> {
    const bubble = this.current;
    if (bubble.gone) {
      this.footerHidden = true;
      return;
    }
    const words = bubble.text.trim();
    if (words) {
      if (words !== bubble.shown || !bubble.stopShown) await this.show(bubble, words, true);
    } else if (bubble.id !== undefined && this.deps.channel.deleteMessage) {
      await this.deps.channel.deleteMessage(this.deps.chatId, bubble.id, {
        signal: this.deps.signal,
      });
      bubble.gone = true;
    }
    // Only after the pass lands: a refused edit must be retried with the newest
    // state, not marked done and left showing a working line above the board.
    this.footerHidden = true;
  }

  /**
   * A bubble's final form: its words only, no footer. `keepStop` keeps the
   * inline Stop button, which is what a suspended footer needs while the chat
   * waits on the owner; every other final edit takes it away.
   */
  private async settle(bubble: Bubble, keepStop = false): Promise<void> {
    if (bubble.gone) return;
    const words = bubble.text.trim();
    if (words) {
      if (words !== bubble.shown || keepStop !== bubble.stopShown)
        await this.show(bubble, words, keepStop);
      return;
    }
    // Status only, or words dropped as a duplicate of the answer: nothing worth
    // keeping once the footer has moved on.
    if (bubble.id === undefined || !this.deps.channel.deleteMessage) return;
    await this.deps.channel.deleteMessage(this.deps.chatId, bubble.id, {
      signal: this.deps.signal,
    });
    bubble.gone = true;
  }

  private async show(bubble: Bubble, text: string, stopButton: boolean): Promise<void> {
    const { channel, chatId, signal } = this.deps;
    const sendProgress = channel.sendProgress?.bind(channel);
    if (bubble.gone || (bubble.id === undefined && !sendProgress)) return;
    const options = {
      signal,
      stopButton,
      retryRateLimit: false,
    };
    if (bubble.id === undefined) {
      if (!sendProgress) return;
      const id = await sendProgress(chatId, text, options);
      if (id) {
        bubble.id = id;
        this.ids.add(id);
      }
    } else {
      if (!channel.editMessage) return;
      await channel.editMessage(chatId, bubble.id, text, options);
    }
    bubble.shown = text;
    bubble.stopShown = stopButton;
  }
}

/** The last line or word break in the second half of `room`, else a hard cut. */
function cutPoint(text: string, room: number): number {
  const head = text.slice(0, room);
  const lineBreak = head.lastIndexOf('\n');
  if (lineBreak > room / 2) return lineBreak;
  const space = head.lastIndexOf(' ');
  return space > room / 2 ? space : room;
}

/** `TelegramRateLimitError.retryAfterMs`, read structurally: this owner is transport-neutral. */
function retryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('retryAfterMs' in err)) return undefined;
  const value = (err as { retryAfterMs: unknown }).retryAfterMs;
  return typeof value === 'number' ? value : undefined;
}
