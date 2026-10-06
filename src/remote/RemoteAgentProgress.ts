import type { AgentProgressEvent } from '../sidebar/AgentProgress';
import type { RemoteChannel } from './types';
import { QUEUED_ACK_DELETE_SECONDS } from './TelegramAcknowledgement';
import { DEFAULT_STATUS, renderProgressFooter } from './remoteProgressRender';
import { keepTail, sanitize, sanitizeToolName } from './remoteProgressText';
import { RemoteLiveBubble } from './RemoteLiveBubble';

/** Telegram allows about one edit per second per chat. */
const DEFAULT_EDIT_INTERVAL_MS = 1_000;
export const CLOCK_INTERVAL_MS = 60_000;
const MAX_STATUS_CHARS = 500;
const MAX_NOTICE_CHARS = 300;
/** Warnings latch, so the tail is bounded rather than the whole turn's worth. */
const MAX_LATCHED_WARNINGS = 4;
const MAX_HEADLINE_CHARS = 160;
/**
 * Bounds the per-turn narration seen-set. A turn that narrates more than this
 * many distinct thoughts has scrolled the oldest far out of view, so they are
 * the ones least worth keeping; dropping them only means a very old repeat
 * could resurface, which is the pre-fix behaviour, not a regression.
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
  /** The turn's words and status footer; absent on a transport that cannot edit. */
  bubble?: RemoteLiveBubble;
  /** Replaces the default status while the turn waits on something else. */
  phase?: string;
  milestone?: string;
  /**
   * Warnings that must survive the next milestone.
   *
   * `milestone` is overwritten by the following tool name a moment later,
   * which is fine for "Running read_file…" and wrong for "agent is repeating
   * the same tool call". Those go here instead and stay for the rest of the turn.
   */
  warnings: string[];
  /**
   * Every narration already delivered this turn.
   *
   * A model can repeat the same finished thought in two NON-adjacent rounds
   * (X, Y, X): a guard that only compares against the preceding narration lets
   * the third through and the phone gets the same paragraph twice. Only a
   * narration that did not stream is checked -- a streamed one is already on
   * screen and only replaces its own words. Cleared by `begin`.
   */
  narrations: string[];
  startedAt: number;
  lastActivityAt: number;
  toolCalls: number;
  clock?: ReturnType<typeof setInterval>;
  /** Out-of-band sends (warnings, images), in order. */
  tail: Promise<void>;
  closed: boolean;
}

/**
 * Mirrors a turn into the chat as it happens.
 *
 * The agent's words stream into real messages, one per text block, and the
 * status footer with the ⏹ Stop button rides on the newest of them (see
 * `RemoteLiveBubble`). A separate status message was tried first and failed:
 * Telegram never moves a message, so it stayed where it was opened while every
 * later bubble appeared below it and the live status scrolled out of view.
 *
 * A new bubble per block is also what notifies the phone: Telegram raises a
 * notification for a send and none for an edit, so a turn that only ever
 * edited one message was silent until it ended.
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
     * Arms deletion of a finished bubble left holding status only ("Forge:
     * completed.", "Forge: failed.") after the fixed queued-ack delay. Bubbles
     * carrying the agent's words are kept; the final answer is a separate
     * message, so deleting a status-only one loses no conversation record.
     */
    private readonly armAfter?: (
      chatId: string,
      messageIds: string[],
      delaySeconds: number,
    ) => void,
    private readonly clockIntervalMs = CLOCK_INTERVAL_MS,
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
    const state: ActiveProgress = {
      origin,
      chatId,
      warnings: [],
      narrations: [],
      startedAt: now,
      lastActivityAt: now,
      toolCalls: 0,
      tail: Promise.resolve(),
      closed: false,
    };
    this.active.set(conversationId, state);
    if (!this.channel.editMessage) return;
    state.bubble = new RemoteLiveBubble(
      {
        channel: this.channel,
        chatId,
        signal: this.signal,
        canDeliver: () => this.safeCanDeliver(chatId),
        maxChars: () => this.maxMessageChars,
        footer: (maximum) => renderProgressFooter(state, maximum, Date.now()),
        intervalMs: this.editIntervalMs,
        report: (err) => this.report(err),
      },
      messageId,
    );
    // The clock keeps the elapsed-time line honest on a quiet turn.
    state.clock = setInterval(() => state.bubble?.request(), this.clockIntervalMs);
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
    const bubble = state?.bubble;
    if (!state || state.closed || !bubble) return;
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
    if (event.kind === 'commentary') {
      bubble.append(sanitize(event.text));
      return;
    }
    if (event.kind === 'reasoning') return;
    if (event.kind === 'narration') {
      const text = sanitize(event.text).trim();
      if (!text || (!bubble.streaming && state.narrations.includes(text))) return;
      state.narrations.push(text);
      if (state.narrations.length > MAX_SEEN_NARRATIONS) state.narrations.shift();
      bubble.narrate(text);
      return;
    }
    if (event.kind === 'phase') {
      const headline = keepTail(sanitize(event.text ?? '').trim(), MAX_HEADLINE_CHARS);
      const next = headline && headline !== DEFAULT_STATUS ? headline : undefined;
      if (next === state.phase) return;
      if (next === undefined) delete state.phase;
      else state.phase = next;
    } else if (event.kind === 'notice') {
      const notice = keepTail(sanitize(event.text).trim(), MAX_NOTICE_CHARS);
      if (!notice) return;
      if (event.severity === 'warning') {
        // Deduplicated: a guard that fires on consecutive rounds would
        // otherwise fill the footer with copies of one sentence.
        if (state.warnings[state.warnings.length - 1] === notice) return;
        state.warnings.push(notice);
        if (state.warnings.length > MAX_LATCHED_WARNINGS) state.warnings.shift();
        // Sent as well as latched, and the two are not redundant. The latched
        // line is the standing reminder in the footer; the message is what
        // actually reaches a phone, because Telegram raises no notification
        // for an edit. "agent is repeating the same tool call -- stopping to
        // avoid a loop" must not wait for the turn to end to be read.
        this.queueOutbound(event.conversationId, state, `⚠ ${notice}`);
      } else {
        state.milestone = notice;
      }
    } else if (event.kind === 'tool') {
      state.toolCalls += 1;
      // A tool call is a block boundary even when no narration came.
      bubble.endBlock();
      const toolName = sanitizeToolName(event.toolName);
      if (!toolName) return;
      state.milestone = `Running ${toolName}…`;
    } else {
      const status = sanitize(event.text).trim();
      if (!status) return;
      state.milestone = keepTail(status, MAX_STATUS_CHARS);
    }
    bubble.request();
  }

  /**
   * Send a generated image to the chat watching this turn, in order behind the
   * pending warnings.
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
        await state.bubble?.flushNow();
        await sendPhoto(state.chatId, filePath, caption, this.signal);
        state.bubble?.strand();
      })
      .catch((err) => this.report(err));
    return 1;
  }

  /**
   * The live turn one of whose bubbles this is, for the Stop button. Any of
   * the turn's bubbles counts: a tap can land just before the button moves on.
   * A finished turn has left `active`, so a tap on its old bubble finds nothing.
   */
  conversationForBubble(chatId: string, messageId: string): string | undefined {
    for (const [conversationId, state] of this.active) {
      if (!state.closed && state.chatId === chatId && state.bubble?.owns(messageId)) {
        return conversationId;
      }
    }
    return undefined;
  }

  async finish(conversationId: string, terminalText: string): Promise<void> {
    const state = this.active.get(conversationId);
    if (!state) return;
    state.closed = true;
    if (state.clock) clearInterval(state.clock);
    await state.tail;
    // Only this state: a new message may have begun for the conversation
    // while the tail settled, and it is not this call's to delete.
    if (this.active.get(conversationId) === state) this.active.delete(conversationId);
    if (!state.bubble || this.signal.aborted) return;
    const statusOnly = await state.bubble.close(terminalText);
    if (statusOnly.length > 0) this.armAfter?.(state.chatId, statusOnly, QUEUED_ACK_DELETE_SECONDS);
  }

  async dispose(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [conversationId, state] of this.active) {
      this.abandon(state);
      pending.push(state.tail);
      this.active.delete(conversationId);
    }
    await Promise.allSettled(pending);
  }

  /** Send one line of its own into the chat, in order behind earlier ones. */
  private queueOutbound(conversationId: string, state: ActiveProgress, text: string): void {
    state.tail = state.tail
      .then(async () => {
        if (state.closed || this.signal.aborted) return;
        if (this.active.get(conversationId) !== state) return;
        if (!(await this.safeCanDeliver(state.chatId))) return;
        await state.bubble?.flushNow();
        await this.channel.send(state.chatId, text.slice(0, this.maxMessageChars), {
          signal: this.signal,
        });
        // The line now sits under the newest bubble; the footer moves below it.
        state.bubble?.strand();
      })
      .catch((err) => this.report(err));
  }

  private drop(conversationId: string): void {
    const previous = this.active.get(conversationId);
    if (!previous) return;
    this.abandon(previous);
    this.active.delete(conversationId);
  }

  /** Stops a turn's timers without a final edit: a replaced or disposed turn. */
  private abandon(state: ActiveProgress): void {
    state.closed = true;
    if (state.clock) clearInterval(state.clock);
    delete state.clock;
    state.bubble?.abandon();
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
