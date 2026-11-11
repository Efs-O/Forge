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
 * The part of the progress owner a bridge needs when its own message stops the
 * turn until the owner answers it.
 *
 * A question board and an approval card both sit below the bubble carrying the
 * `Forge: working…` line, and Telegram never moves a message, so the line has
 * to come off for the length of the wait and reopen below the board and its
 * receipt. `RemoteController` hands this to each bridge's `start()`; a bridge
 * that gets nothing (a rig, a transport with no progress bubble) changes
 * nothing.
 */
export type RemoteWaitFooter = Pick<RemoteAgentProgress, 'suspendFooter' | 'resumeFooter'>;

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

/** Streams turn text into messages, with the footer and Stop on the newest bubble. */
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
    private readonly contextBudget?: (
      conversationId: string,
    ) => { used: number; max: number } | undefined,
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
        footer: (maximum) => {
          const context = this.contextBudget?.(conversationId);
          return renderProgressFooter(
            { ...state, ...(context ? { context } : {}) },
            maximum,
            Date.now(),
          );
        },
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
   * Hides this conversation's working line while its turn waits on the owner.
   *
   * Called by the bridge that put the board or card on screen. Idempotent, so a
   * multi-step question that sends a second board does nothing the second time;
   * a no-op once the turn has closed, and on an aborted controller.
   */
  suspendFooter(conversationId: string): void {
    const state = this.active.get(conversationId);
    if (!state || state.closed || this.signal.aborted) return;
    state.bubble?.suspend();
  }

  /**
   * Reopens the working line below the board and its receipt, once the answer
   * has landed. A bubble that is not suspended is not this call's to move: that
   * is what makes a stale resume (the turn ended, or a new turn started for the
   * same conversation while a board was pending) a no-op rather than a spurious
   * bubble under the new turn.
   */
  resumeFooter(conversationId: string): void {
    const state = this.active.get(conversationId);
    if (!state || state.closed || this.signal.aborted) return;
    state.bubble?.resume();
  }

  /** Whether either a sidebar or a chat started a live turn. */
  has(conversationId: string): boolean {
    const state = this.active.get(conversationId);
    return state !== undefined && !state.closed;
  }

  /** The chat watching a sidebar-started turn. */
  hostChat(conversationId: string): string | undefined {
    const state = this.active.get(conversationId);
    return state && !state.closed && state.origin === 'host' ? state.chatId : undefined;
  }

  handle(event: AgentProgressEvent): void {
    const state = this.active.get(event.conversationId);
    const bubble = state?.bubble;
    if (!state || state.closed || !bubble) return;
    if (event.kind === 'end') {
      // RemoteQueueDrain closes remote requests with their richer queue
      // outcome; this event closes only a host-started turn.
      if (state.origin !== 'host') return;
      void this.finish(
        event.conversationId,
        event.outcome === 'stopped'
          ? 'Forge: stopped.'
          : event.outcome === 'ok'
            ? 'Forge: completed.'
            : 'Forge: failed.',
      );
      return;
    }
    state.lastActivityAt = Date.now();
    if (event.kind === 'commentary') {
      bubble.append(sanitize(event.text));
      return;
    }
    if (event.kind === 'reasoning') return;
    // A turn-start event carries no text: it exists so the bus can time a turn
    // that never speaks. The line above already kept this message alive, and
    // the milestone stays whatever the turn last said, so nothing is edited.
    if (event.kind === 'start') return;
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

  /** The live turn watching this chat, if any; a leftover 0.17.67 key tap uses chat identity. */
  conversationForChat(chatId: string): string | undefined {
    for (const [conversationId, state] of this.active) {
      if (!state.closed && state.chatId === chatId) return conversationId;
    }
    return undefined;
  }

  /** Sends a sidebar prompt after earlier out-of-band lines and moves the footer below it. */
  mirrorPrompt(
    conversationId: string,
    text: string,
    enqueueIfLocked: (chatId: string, text: string) => Promise<void>,
  ): boolean {
    const state = this.active.get(conversationId);
    if (!state || state.closed) return false;
    this.queueOutbound(conversationId, state, text, {
      prompt: true,
      enqueueIfLocked,
    });
    return true;
  }

  /**
   * Closes one turn's bubbles. `terminalText` absent means the answer is
   * already on screen, so no outcome line is written and no status-only message
   * is left for the delete timer — the caller delivers first for exactly that
   * reason.
   */
  async finish(
    conversationId: string,
    terminalText?: string,
    replyIds?: ReadonlySet<string>,
  ): Promise<void> {
    const state = this.active.get(conversationId);
    if (!state) return;
    await this.finishState(conversationId, state, terminalText, replyIds);
  }

  private async finishState(
    conversationId: string,
    state: ActiveProgress,
    terminalText?: string,
    replyIds?: ReadonlySet<string>,
  ): Promise<void> {
    state.closed = true;
    if (state.clock) clearInterval(state.clock);
    try {
      await state.tail;
    } catch (err) {
      this.report(err);
    }
    // Only this state: a new message may have begun for the conversation
    // while the tail settled, and it is not this call's to delete.
    if (this.active.get(conversationId) === state) this.active.delete(conversationId);
    try {
      if (state.bubble && !this.signal.aborted) {
        const statusOnly = await state.bubble.close(terminalText, replyIds);
        if (statusOnly.length > 0)
          this.armAfter?.(state.chatId, statusOnly, QUEUED_ACK_DELETE_SECONDS);
      }
    } catch (err) {
      this.report(err);
    }
  }

  async telegramReplyTargets(conversationId: string) {
    if (this.channel.name !== 'telegram') return [];
    const state = this.active.get(conversationId);
    if (!state?.bubble || state.closed) return [];
    return state.bubble.replyTargets();
  }

  claimMirroredReply(conversationId: string, chatId: string) {
    const state = this.active.get(conversationId);
    if (
      this.channel.name !== 'telegram' ||
      !state?.bubble ||
      state.origin !== 'host' ||
      state.chatId !== chatId ||
      state.closed
    )
      return undefined;
    state.closed = true;
    if (state.clock) clearInterval(state.clock);
    return {
      targets: state.bubble.replyTargets(),
      finish: (ids?: ReadonlySet<string>) =>
        this.finishState(conversationId, state, undefined, ids),
    };
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
  private queueOutbound(
    conversationId: string,
    state: ActiveProgress,
    text: string,
    options?: {
      prompt?: boolean;
      enqueueIfLocked?: (chatId: string, text: string) => Promise<void>;
    },
  ): void {
    state.tail = state.tail
      .then(async () => {
        if ((state.closed && !options?.prompt) || this.signal.aborted) return;
        if (this.active.get(conversationId) !== state) return;
        if (!(await this.safeCanDeliver(state.chatId))) {
          await options?.enqueueIfLocked?.(state.chatId, text);
          return;
        }
        await state.bubble?.flushNow();
        if (options?.prompt && state.origin === 'host' && this.channel.sendProgressPrompt) {
          await this.channel.sendProgressPrompt(state.chatId, text, { signal: this.signal });
        } else {
          await this.channel.send(state.chatId, text.slice(0, this.maxMessageChars), {
            signal: this.signal,
          });
        }
        // The line now sits under the newest bubble; the footer moves below it.
        state.bubble?.strand();
      })
      .catch(async (err) => {
        this.report(err);
        if (!options?.prompt) return;
        try {
          await options.enqueueIfLocked?.(state.chatId, text);
        } catch (fallbackError) {
          this.report(fallbackError);
        }
      });
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
