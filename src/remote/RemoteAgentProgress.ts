import type { AgentProgressEvent } from '../sidebar/AgentProgress';
import type { RemoteChannel } from './types';

const DEFAULT_EDIT_INTERVAL_MS = 1_500;
const MAX_STATUS_CHARS = 500;
const MAX_TOOL_NAME_CHARS = 80;
const MAX_NOTICE_CHARS = 300;
/** Warnings latch, so the tail is bounded rather than the whole turn's worth. */
const MAX_LATCHED_WARNINGS = 4;
const DEFAULT_HEADLINE = 'Forge: working…';
const MAX_HEADLINE_CHARS = 160;
/**
 * Bounds the per-turn narration seen-set. A turn that narrates more than this
 * many distinct thoughts has already overflowed the message long ago, so the
 * oldest entries are the ones least worth keeping; dropping them only means a
 * very old repeat could resurface, which is the pre-fix behaviour, not a
 * regression.
 */
const MAX_SEEN_NARRATIONS = 32;

type CanDeliver = (chatId: string) => boolean | Promise<boolean>;

/**
 * Who asked for the turn this message reports.
 *
 * `remote` is a prompt RemoteQueueDrain admitted from a chat: that path opens
 * the message before the turn starts and closes it with the request's outcome,
 * and RemoteNotificationFanout must not also echo the answer.
 *
 * `host` is a turn started in the sidebar, whose message is opened lazily on
 * the first progress event and closed by the turn's own `end`. The fanout is
 * deliberately blind to it -- the live trace and the mirrored answer are two
 * different things there, and suppressing the answer would leave the phone
 * with a truncated tail and no final word.
 */
export type ProgressOrigin = 'remote' | 'host';

interface ActiveProgress {
  origin: ProgressOrigin;
  chatId: string;
  messageId: string;
  headline: string;
  milestone?: string;
  /**
   * Warnings that must survive the next milestone.
   *
   * `milestone` is overwritten by the following tool name ~1.5s later, which is
   * fine for "Running read_file…" and wrong for "agent is repeating the same
   * tool call". Those go here instead and stay for the rest of the turn.
   */
  warnings: string[];
  lastText: string;
  /**
   * Every narration already delivered as its own message this turn.
   *
   * A model can repeat the same finished thought in two NON-adjacent rounds
   * (X, Y, X): the middle round changes the text, so a guard that only compares
   * against the immediately preceding narration lets the third one through and
   * the phone gets the same paragraph twice. Remembering the whole turn's worth
   * (bounded) closes that gap. Cleared by `begin`, so a later turn may say the
   * same thing again.
   */
  narrations: string[];
  timer?: ReturnType<typeof setTimeout>;
  tail: Promise<void>;
  closed: boolean;
}

/**
 * Coalesces visible turn progress into one rate-limited remote message edit.
 *
 * The progress "bubble" is a single message opened via `sendProgress` and then
 * edited in place (`editMessageText`). Telegram does not let a message move to
 * the bottom of a chat — it keeps the position it was created at — so the
 * bubble stays at the top of the turn's activity while narrations and the
 * final answer are sent as separate messages and appear below it. That is the
 * intended layout, not a bug. Making the bubble "follow" the progress would
 * mean delete-and-resend on every update, and Telegram notifies on sends but
 * stays silent on edits — so the in-place edit is exactly what keeps a long
 * turn from spamming the phone with a notification per progress tick.
 *
 * The bubble carries status only (headline, latched warnings, the running
 * tool) — never the model's streamed words. It used to stream `commentary`
 * tokens too, which meant every thought and the final answer appeared twice:
 * first inside the bubble, then again as their own message at the bottom,
 * after which the bubble copy vanished. Each piece of text now appears once,
 * as a message. TRIAL as of 0.16.0: the user may prefer the live text back;
 * to revert, restore the `commentary` field, its append in `handle`, its
 * section in `render`, and the clear after a narration send (see the commit "keep
 * streamed words out of the Telegram progress bubble" for the exact diff).
 */
export class RemoteAgentProgress {
  private readonly active = new Map<string, ActiveProgress>();

  constructor(
    private readonly channel: RemoteChannel,
    private readonly signal: AbortSignal,
    private readonly canDeliver: CanDeliver,
    private maxMessageChars: number,
    private readonly editIntervalMs = DEFAULT_EDIT_INTERVAL_MS,
    private readonly onError?: (message: string) => void,
  ) {}

  updateMaxMessageChars(maxMessageChars: number): void {
    this.maxMessageChars = maxMessageChars;
  }

  begin(
    conversationId: string,
    chatId: string,
    messageId: string,
    origin: ProgressOrigin = 'remote',
  ): void {
    this.drop(conversationId);
    this.active.set(conversationId, {
      origin,
      chatId,
      messageId,
      headline: DEFAULT_HEADLINE,
      warnings: [],
      lastText: DEFAULT_HEADLINE,
      narrations: [],
      tail: Promise.resolve(),
      closed: false,
    });
  }

  /**
   * Whether a live progress message is already reporting this conversation's
   * turn. Only begin() populates the map, and only RemoteQueueDrain calls it,
   * so a true answer means the prompt came from a chat and that chat is
   * already being told — which is exactly what turn mirroring must not repeat.
   */
  owns(conversationId: string): boolean {
    const state = this.active.get(conversationId);
    return state !== undefined && !state.closed && state.origin === 'remote';
  }

  /**
   * Whether ANY live message reports this turn, whoever started it.
   *
   * Distinct from `owns` on purpose: this is the guard that stops a second
   * message being opened for a turn already being reported, and it must count
   * the host-started ones that `owns` deliberately hides from the fanout.
   */
  has(conversationId: string): boolean {
    const state = this.active.get(conversationId);
    return state !== undefined && !state.closed;
  }

  /**
   * The chat a live sidebar-started ('host') message reports to, if any.
   * HostProgressOpener re-checks it against the current pairing on every
   * event, so a chat switched to another conversation mid-turn stops hearing
   * this one. Chat-queued ('remote') messages belong to the chat that sent the
   * prompt and are not asked about.
   */
  hostChat(conversationId: string): string | undefined {
    const state = this.active.get(conversationId);
    return state && !state.closed && state.origin === 'host' ? state.chatId : undefined;
  }

  handle(event: AgentProgressEvent): void {
    const state = this.active.get(event.conversationId);
    if (!state || state.closed || !this.channel.editMessage) return;
    if (event.kind === 'end') {
      // Only the lazily-opened kind. A remote request's message is closed by
      // RemoteQueueDrain with the request's own outcome, which knows the two
      // endings this event cannot tell apart: a cancelled request also ends
      // its turn "successfully", and closing it here would report it as done.
      if (state.origin !== 'host') return;
      void this.finish(event.conversationId, event.ok ? 'Forge: completed.' : 'Forge: failed.');
      return;
    }
    if (event.kind === 'narration') {
      this.queueNarration(event.conversationId, state, event.text);
      return;
    }
    // Streamed tokens stay out of the bubble; the finished text arrives as a
    // narration or the final answer instead. See the class comment.
    if (event.kind === 'commentary') return;
    if (event.kind === 'phase') {
      const headline = keepTail(sanitize(event.text ?? '').trim(), MAX_HEADLINE_CHARS);
      const next = headline || DEFAULT_HEADLINE;
      if (next === state.headline) return;
      state.headline = next;
    } else if (event.kind === 'notice') {
      const notice = keepTail(sanitize(event.text).trim(), MAX_NOTICE_CHARS);
      if (!notice) return;
      if (event.severity === 'warning') {
        // Deduplicated: a guard that fires on consecutive rounds would
        // otherwise fill the message with copies of one sentence.
        if (state.warnings[state.warnings.length - 1] === notice) return;
        state.warnings.push(notice);
        if (state.warnings.length > MAX_LATCHED_WARNINGS) state.warnings.shift();
        // Sent as well as latched, and the two are not redundant. The latched
        // line is the standing reminder a reader scrolling the bubble sees; the
        // message is the only thing that actually reaches a phone, because
        // Telegram raises no notification for an edit. "agent is repeating the
        // same tool call -- stopping to avoid a loop" is precisely the sentence
        // that must not wait for the turn to end to be read.
        this.queueOutbound(event.conversationId, state, `⚠ ${notice}`);
      } else {
        state.milestone = notice;
      }
    } else if (event.kind === 'tool') {
      const toolName = sanitizeToolName(event.toolName);
      if (!toolName) return;
      state.milestone = `Running ${toolName}…`;
    } else {
      const status = sanitize(event.text).trim();
      if (!status) return;
      state.milestone = keepTail(status, MAX_STATUS_CHARS);
    }
    this.schedule(event.conversationId, state);
  }

  /**
   * Send a generated image to the chat watching this turn, in order behind the
   * pending edits and narrations.
   *
   * Returns how many chats it was queued to -- 0 or 1 -- because generate_image
   * reports that to the model: a live message for the turn is the only proof a
   * phone is watching, and claiming a send without one repeats ask_user's lie.
   */
  deliverImage(conversationId: string, filePath: string, caption: string): number {
    const state = this.active.get(conversationId);
    if (!state || state.closed || !this.channel.sendPhoto) return 0;
    const sendPhoto = this.channel.sendPhoto.bind(this.channel);
    state.tail = state.tail
      .then(async () => {
        if (state.closed || this.signal.aborted) return;
        if (this.active.get(conversationId) !== state) return;
        if (!(await this.safeCanDeliver(state.chatId))) return;
        await sendPhoto(state.chatId, filePath, caption, this.signal);
      })
      .catch((err) => this.report(err));
    return 1;
  }

  async finish(conversationId: string, terminalText: string): Promise<void> {
    const state = this.active.get(conversationId);
    if (!state) return;
    state.closed = true;
    if (state.timer) clearTimeout(state.timer);
    delete state.timer;
    await state.tail;
    // Only this state: a new message may have begun for the conversation
    // while the tail settled, and it is not this call's to delete.
    if (this.active.get(conversationId) === state) this.active.delete(conversationId);
    if (this.signal.aborted || !this.channel.editMessage) return;
    if (!(await this.safeCanDeliver(state.chatId))) return;
    await this.channel
      .editMessage(state.chatId, state.messageId, terminalText.slice(0, this.maxMessageChars), {
        signal: this.signal,
      })
      .catch((err) => this.report(err));
  }

  async dispose(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [conversationId, state] of this.active) {
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      pending.push(state.tail);
      this.active.delete(conversationId);
    }
    await Promise.allSettled(pending);
  }

  /**
   * Deliver one finished mid-turn thought as a new message.
   *
   * A new message rather than an edit because that is the whole point: Telegram
   * notifies on a send and stays silent on an edit, so a turn that only ever
   * edited its bubble was invisible to a phone until it ended.
   *
   * Rides `state.tail` with the edits so a narration cannot overtake the bubble
   * update that preceded it.
   */
  private queueNarration(conversationId: string, state: ActiveProgress, raw: string): void {
    const text = sanitize(raw).trim();
    if (!text || state.narrations.includes(text)) return;
    state.narrations.push(text);
    if (state.narrations.length > MAX_SEEN_NARRATIONS) state.narrations.shift();
    this.queueOutbound(conversationId, state, text);
  }

  /** Send one line of its own into the chat, in order behind the pending edits. */
  private queueOutbound(conversationId: string, state: ActiveProgress, text: string): void {
    state.tail = state.tail
      .then(async () => {
        if (state.closed || this.signal.aborted) return;
        if (this.active.get(conversationId) !== state) return;
        if (!(await this.safeCanDeliver(state.chatId))) return;
        await this.channel.send(state.chatId, text.slice(0, this.maxMessageChars), {
          signal: this.signal,
        });
      })
      .catch((err) => this.report(err));
  }

  private schedule(conversationId: string, state: ActiveProgress): void {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      delete state.timer;
      this.queueEdit(conversationId, state);
    }, this.editIntervalMs);
  }

  private queueEdit(conversationId: string, state: ActiveProgress): void {
    const text = render(state, this.maxMessageChars);
    if (text === state.lastText) return;
    state.tail = state.tail
      .then(async () => {
        if (state.closed || this.signal.aborted || !this.channel.editMessage) return;
        if (this.active.get(conversationId) !== state) return;
        if (!(await this.safeCanDeliver(state.chatId))) return;
        await this.channel.editMessage(state.chatId, state.messageId, text, {
          signal: this.signal,
        });
        state.lastText = text;
      })
      .catch((err) => this.report(err));
  }

  private drop(conversationId: string): void {
    const previous = this.active.get(conversationId);
    if (!previous) return;
    previous.closed = true;
    if (previous.timer) clearTimeout(previous.timer);
    this.active.delete(conversationId);
  }

  private report(err: unknown): void {
    this.onError?.(
      `Forge remote progress update failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  private async safeCanDeliver(chatId: string): Promise<boolean> {
    try {
      return await this.canDeliver(chatId);
    } catch (err) {
      this.report(err);
      return false;
    }
  }
}

function render(state: ActiveProgress, maximum: number): string {
  const sections = [state.headline];
  // Warnings sit below the headline and above the live milestone: they are
  // the part of the message the reader most needs and the part most likely to
  // be trimmed, so they are never the first thing the tail cut reaches.
  if (state.warnings.length) {
    sections.push(state.warnings.map((warning) => `\u26a0 ${warning}`).join('\n'));
  }
  if (state.milestone) sections.push(state.milestone);
  return keepTailWithPrefix(sections.join('\n\n'), maximum, `${state.headline}\n\n`);
}

function sanitize(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += character;
    }
  }
  return output;
}

function sanitizeToolName(value: string): string {
  return (value.match(/^[a-zA-Z0-9_.:-]+/)?.[0] ?? '').slice(0, MAX_TOOL_NAME_CHARS);
}

function keepTail(value: string, maximum: number): string {
  return value.length <= maximum ? value : `…${value.slice(-(maximum - 1))}`;
}

function keepTailWithPrefix(value: string, maximum: number, prefix: string): string {
  if (value.length <= maximum) return value;
  const room = Math.max(1, maximum - prefix.length);
  return `${prefix}…${value.slice(-(room - 1))}`;
}
