import type { AgentProgressEvent } from '../sidebar/AgentProgress';
import type { RemoteChannel } from './types';
import { describeError } from '../util/describeError';
import { QUEUED_ACK_DELETE_SECONDS } from './TelegramAcknowledgement';
import { DRAFT_HEARTBEAT_MS } from './telegramRichDraft';
import type { RemoteDraftRegistry } from './RemoteDraftRegistry';
import { renderRemoteProgress } from './remoteProgressRender';
import { keepTail, sanitize, sanitizeToolName } from './remoteProgressText';
import { appendStream, DRAFT_STREAM_INTERVAL_MS, RemoteDraftLane } from './RemoteDraftLane';

const DEFAULT_EDIT_INTERVAL_MS = 1_500;
export const CLOCK_INTERVAL_MS = 60_000;
const MAX_STATUS_CHARS = 500;
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
  /** The status bubble: a plain message, edited in place. */
  messageId: string;
  /**
   * The words preview: a rich draft carrying only the model's streamed words,
   * opened on the first word and never carrying status. Telegram's Stop update
   * names it by draft id, and every update reuses the id so it animates.
   */
  draftId?: number | undefined;
  /** `off` once the transport refused a draft: the turn streams nothing more. */
  draftPhase: 'none' | 'opening' | 'open' | 'off';
  /** The draft's own send lane, beside `tail` rather than on it. */
  draftLane?: RemoteDraftLane;
  draftTimer?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  /** The turn's streamed words, append-only, so Telegram never re-types them. */
  words: string;
  /** What the preview last showed. */
  draftText: string;
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
  queuedText?: string;
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
  startedAt: number;
  lastActivityAt: number;
  toolCalls: number;
  timer?: ReturnType<typeof setTimeout>;
  clock?: ReturnType<typeof setInterval>;
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
 * The bubble carries status only, never the model's streamed words: it is
 * permanent, so streaming into it showed every thought twice (`4dcb826`).
 * The words go to a separate rich draft preview that carries nothing else —
 * a status in a draft is re-typed letter by letter on every change, which is
 * what made "Forge: working…" crawl. See `RemoteDraftLane` and
 * docs/plans/TELEGRAM_STATUS_BUBBLE_RESTORE_PLAN.md.
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
    /**
     * Arms deletion of the finished progress bubble after the fixed queued-ack
     * delay. The bubble is status only ("Forge: completed.", "Forge: failed.",
     * a loop-guard warning) — the real answer is always a separate message
     * (see the class comment), so deleting this one loses no conversation
     * record; it just stops a purely transient status line from sitting in
     * the chat forever like the real replies around it do not.
     */
    private readonly armAfter?: (
      chatId: string,
      messageIds: string[],
      delaySeconds: number,
    ) => void,
    private readonly clockIntervalMs = CLOCK_INTERVAL_MS,
    /**
     * Live draft previews this progress owns, shared with the controller so a
     * Telegram Stop update can resolve a draft id back to a conversation.
     * Absent for transports with no rich drafts.
     */
    private readonly drafts?: RemoteDraftRegistry | undefined,
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
    const now = Date.now();
    this.active.set(conversationId, {
      origin,
      chatId,
      messageId,
      draftPhase: this.channel.richDraft ? 'none' : 'off',
      words: '',
      draftText: '',
      headline: DEFAULT_HEADLINE,
      warnings: [],
      lastText: DEFAULT_HEADLINE,
      narrations: [],
      startedAt: now,
      lastActivityAt: now,
      toolCalls: 0,
      tail: Promise.resolve(),
      closed: false,
    });
    const state = this.active.get(conversationId)!;
    if (state.draftPhase !== 'off') {
      state.draftLane = new RemoteDraftLane(
        () => this.sendDraft(conversationId, state),
        (err) => this.report(err),
      );
    }
    if (this.channel.editMessage) {
      // The 60s clock keeps the elapsed-time line honest on a quiet turn.
      state.clock = setInterval(() => this.queueEdit(conversationId, state), this.clockIntervalMs);
    }
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
    if (!state || state.closed || !(this.channel.editMessage || this.channel.richDraft)) return;
    if (event.kind === 'end') {
      // Only the lazily-opened kind. A remote request's message is closed by
      // RemoteQueueDrain with the request's own outcome, which knows the two
      // endings this event cannot tell apart: a cancelled request also ends
      // its turn "successfully", and closing it here would report it as done.
      if (state.origin !== 'host') return;
      void this.finish(event.conversationId, event.ok ? 'Forge: completed.' : 'Forge: failed.');
      return;
    }
    state.lastActivityAt = Date.now();
    if (event.kind === 'narration') {
      // The words stay in the preview: clearing them would re-type the whole
      // draft, and the preview is retired by Telegram anyway.
      this.queueNarration(event.conversationId, state, event.text);
      return;
    }
    // Streamed tokens reach the words preview only: it is retired by Telegram,
    // so the words appear once as a record. The bubble is permanent and keeps
    // them out (see the class comment).
    if (event.kind === 'commentary' && state.draftLane && state.draftPhase !== 'off') {
      const next = appendStream(state.words, event.text);
      if (next === state.words) return;
      state.words = next;
      this.scheduleDraft(state);
      return;
    }
    if (event.kind === 'commentary' || event.kind === 'reasoning') return;
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
      state.toolCalls += 1;
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
    this.clearTimers(state);
    await state.tail;
    await state.draftLane?.idle();
    // Only this state: a new message may have begun for the conversation
    // while the tail settled, and it is not this call's to delete.
    if (this.active.get(conversationId) === state) {
      this.active.delete(conversationId);
      if (state.draftId !== undefined) this.drafts?.forgetConversation(conversationId);
    }
    if (this.signal.aborted) return;
    // The words preview is left to expire on Telegram's side (~30 s with no
    // heartbeat); the answer and every narration are already real messages.
    if (!this.channel.editMessage) return;
    if (!(await this.safeCanDeliver(state.chatId))) return;
    await this.channel
      .editMessage(state.chatId, state.messageId, terminalText.slice(0, this.maxMessageChars), {
        signal: this.signal,
      })
      .catch((err) => this.report(err));
    this.armAfter?.(state.chatId, [state.messageId], QUEUED_ACK_DELETE_SECONDS);
  }

  async dispose(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [conversationId, state] of this.active) {
      state.closed = true;
      this.clearTimers(state);
      pending.push(state.tail);
      if (state.draftLane) pending.push(state.draftLane.idle());
      this.active.delete(conversationId);
      if (state.draftId !== undefined) this.drafts?.forgetConversation(conversationId);
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

  private scheduleDraft(state: ActiveProgress): void {
    if (state.draftTimer) return;
    state.draftTimer = setTimeout(
      () => {
        delete state.draftTimer;
        if (this.draftText(state) !== state.draftText) state.draftLane?.request();
      },
      Math.min(this.editIntervalMs, DRAFT_STREAM_INTERVAL_MS),
    );
  }

  private queueEdit(conversationId: string, state: ActiveProgress): void {
    const text = renderRemoteProgress(state, this.maxMessageChars, Date.now());
    if (text === state.lastText || text === state.queuedText) return;
    state.queuedText = text;
    state.tail = state.tail
      .then(async () => {
        if (state.closed || this.signal.aborted) return;
        if (this.active.get(conversationId) !== state) return;
        if (!this.channel.editMessage) return;
        if (!(await this.safeCanDeliver(state.chatId))) return;
        await this.channel.editMessage(state.chatId, state.messageId, text, {
          signal: this.signal,
        });
        state.lastText = text;
      })
      .catch((err) => this.report(err))
      .finally(() => {
        if (state.queuedText === text) delete state.queuedText;
      });
  }

  private draftText(state: ActiveProgress): string {
    return state.words.trim().slice(0, this.maxMessageChars);
  }

  /**
   * One words-preview send, rendered when it is actually sent so a coalesced
   * request carries the newest words. The first send opens the draft; later
   * ones reuse its id so Telegram animates only the appended words.
   */
  private async sendDraft(conversationId: string, state: ActiveProgress): Promise<void> {
    const rich = this.channel.richDraft;
    if (!rich || state.draftPhase === 'off' || state.draftPhase === 'opening') return;
    if (state.closed || this.signal.aborted || this.active.get(conversationId) !== state) return;
    const text = this.draftText(state);
    if (!text) return;
    if (!(await this.safeCanDeliver(state.chatId))) return;
    if (state.draftId !== undefined) {
      await rich.updateDraft(state.chatId, state.draftId, text, { signal: this.signal });
      state.draftText = text;
      return;
    }
    // Read before the await: an unpair during the open must not leave this
    // preview registered as a Stop path for the revoked pairing.
    const epoch = this.drafts?.epoch();
    state.draftPhase = 'opening';
    const outcome = await rich
      .beginDraft(state.chatId, text, { signal: this.signal })
      .catch((err: unknown) => ({ kind: 'unknown' as const, error: describeError(err) }));
    if (outcome.kind !== 'open') {
      // Refused or unknown: stream nothing more this turn rather than risk a
      // second preview. The bubble and the narrations still report the turn.
      state.draftPhase = 'off';
      if (outcome.kind === 'unknown') this.report(new Error(outcome.error));
      return;
    }
    state.draftPhase = 'open';
    state.draftId = outcome.draftId;
    state.draftText = text;
    if (state.closed || this.active.get(conversationId) !== state) return;
    if (epoch === undefined || this.drafts?.isCurrent(epoch)) {
      this.drafts?.register({ chatId: state.chatId, conversationId, draftId: outcome.draftId });
    }
    // A preview expires after ~30 s without an update, taking its Stop button
    // with it, so a quiet stretch of the turn re-sends the same words.
    const lane = state.draftLane;
    state.heartbeat = setInterval(
      () => lane?.request(),
      Math.min(this.clockIntervalMs, DRAFT_HEARTBEAT_MS),
    );
  }

  private drop(conversationId: string): void {
    const previous = this.active.get(conversationId);
    if (!previous) return;
    previous.closed = true;
    this.clearTimers(previous);
    this.active.delete(conversationId);
    if (previous.draftId !== undefined) this.drafts?.forgetConversation(conversationId);
  }

  private clearTimers(state: ActiveProgress): void {
    if (state.timer) clearTimeout(state.timer);
    if (state.draftTimer) clearTimeout(state.draftTimer);
    if (state.clock) clearInterval(state.clock);
    if (state.heartbeat) clearInterval(state.heartbeat);
    delete state.timer;
    delete state.draftTimer;
    delete state.clock;
    delete state.heartbeat;
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
