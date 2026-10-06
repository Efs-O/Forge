import type { RemoteChannel } from './types';

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
 * status footer and the Stop button only on the newest.
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
    const old = this.current;
    this.retire(old);
    if (this.block === 'streaming' && old.text.trim()) {
      this.overflow.push(old);
      this.split = true;
    }
    this.current = { text: '' };
    this.request();
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
   */
  async close(terminalText: string): Promise<string[]> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    if (this.deps.signal.aborted || !(await this.deps.canDeliver())) return [];
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
    if (last.text.trim()) {
      await this.settle(last).catch((err) => this.deps.report(err));
      return [];
    }
    if (last.id === undefined || !this.deps.channel.editMessage) return [];
    try {
      await this.deps.channel.editMessage(
        this.deps.chatId,
        last.id,
        terminalText.slice(0, this.deps.maxChars()),
        { signal: this.deps.signal },
      );
    } catch (err) {
      this.deps.report(err);
    }
    return [last.id];
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

  private retire(bubble: Bubble): void {
    if (bubble.id === undefined && !bubble.text.trim()) return;
    this.retiring.push(bubble);
  }

  private footerRoom(): number {
    return Math.min(MAX_FOOTER_CHARS, Math.floor(this.deps.maxChars() / 2));
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
          await delay(wait, this.deps.signal);
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
    const bubble = this.current;
    const footer = this.deps.footer(this.footerRoom());
    const words = bubble.text.trim();
    const text = words ? `${words}\n\n${footer}` : footer;
    if (text !== bubble.shown) await this.show(bubble, text, true);
  }

  /** A bubble's final form: its words only, no footer, no keyboard. */
  private async settle(bubble: Bubble): Promise<void> {
    const words = bubble.text.trim();
    if (words) {
      if (words !== bubble.shown) await this.show(bubble, words, false);
      return;
    }
    // Status only, or words dropped as a duplicate of the answer: nothing worth
    // keeping once the footer has moved on.
    if (bubble.id !== undefined && this.deps.channel.deleteMessage) {
      await this.deps.channel.deleteMessage(this.deps.chatId, bubble.id, {
        signal: this.deps.signal,
      });
    }
  }

  private async show(bubble: Bubble, text: string, stopButton: boolean): Promise<void> {
    const { channel, chatId, signal } = this.deps;
    const options = { signal, stopButton, retryRateLimit: false };
    if (bubble.id === undefined) {
      if (!channel.sendProgress) return;
      const id = await channel.sendProgress(chatId, text, options);
      if (id) {
        bubble.id = id;
        this.ids.add(id);
      }
    } else {
      if (!channel.editMessage) return;
      await channel.editMessage(chatId, bubble.id, text, options);
    }
    bubble.shown = text;
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

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
