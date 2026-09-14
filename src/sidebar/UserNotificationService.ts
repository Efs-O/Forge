export interface UserNotificationEvent {
  conversationId?: string;
  /** The message, or the caption when `imagePath` is set. */
  text: string;
  /** Absolute path of an image to deliver as a photo (`generate_image`). */
  imagePath?: string;
}

/** Returns the number of remote chats the message was queued to. */
export type UserNotificationSink = (event: UserNotificationEvent) => Promise<number>;

/** Notifications a single turn may send in a burst before the tool refuses. */
export const NOTIFY_TURN_LIMIT = 5;

/**
 * Quiet time that returns the whole budget.
 *
 * The cap was sized against `max_tool_rounds` (40) to stop a runaway loop
 * spamming one turn -- see docs/plans/NOTIFY_USER_PLAN.md, which logs the 5 as
 * a guess to revisit. The case it did not anticipate is a long unattended run:
 * an overnight benchmark is ONE turn, so a user who asked for a report every
 * two hours got four of them and then silence, and the refusal told the agent
 * to "put it in your final reply" -- hours away, when the run ends.
 *
 * Gating on quiet time rather than on a bigger number is what separates the
 * two cases without having to tell them apart: spam is bursty by definition,
 * and a cadence report is spaced by definition. Five minutes of silence buys
 * back the full five, so a 2-hour cadence never meets the cap at all, while a
 * loop calling this every round still hits it on the sixth call.
 */
export const NOTIFY_IDLE_RESET_MS = 5 * 60_000;

/**
 * Conversation key for a notification raised outside any conversation.
 *
 * The leading NUL is what makes it un-collidable with a real conversation id.
 * Written as the `\0` escape rather than a raw NUL byte: the raw form made git
 * classify this whole file as binary, so it had no diffs and no useful blame,
 * and ripgrep skipped it.
 */
const NO_CONVERSATION = '\0no-conversation';

/**
 * The single owner of a message the agent pushes to the user mid-turn.
 *
 * Transport-neutral for the same reason UserQuestionService is: a turn driven
 * from Telegram must not signal the user by lighting up a VS Code window nobody
 * is looking at. Sinks are registered by whatever transports are live, and the
 * fan-out reports how many chats actually took the message.
 *
 * That count is load-bearing, not decoration. It is the only thing that lets
 * notify_user tell the model the truth about whether the user was reached:
 * ask_user shipped returning a bare "(cancelled)" the model read as a real
 * answer, and a notify_user that reported "sent" into a void would repeat that
 * failure with a longer fuse -- the agent claiming it had notified the user
 * while their phone stayed silent.
 */
export class UserNotificationService {
  private readonly sinks = new Set<UserNotificationSink>();
  private readonly sent = new Map<string, number>();
  private readonly lastSentAt = new Map<string, number>();
  private reachProbe: ((conversationId: string) => number) | undefined;

  constructor(
    private readonly onSinkError?: (message: string) => void,
    /** Injectable for tests; production reads the wall clock. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Registers the "can I reach this conversation out of band" probe.
   *
   * Owned here because this class is already the single answer to that
   * question -- `notify()`'s return count is the same fact after the fact.
   * The remote runtime registers it on startup and disposes it on shutdown, so
   * with no transport running the probe is absent and reach is 0, which is the
   * truth rather than a default.
   */
  setReachProbe(probe: (conversationId: string) => number): { dispose(): void } {
    this.reachProbe = probe;
    return {
      dispose: () => {
        if (this.reachProbe === probe) this.reachProbe = undefined;
      },
    };
  }

  /** Remote chats that would receive a notification for this conversation. */
  reach(conversationId: string | undefined): number {
    if (!conversationId || !this.reachProbe) return 0;
    try {
      return this.reachProbe(conversationId);
    } catch {
      // A probe that throws must not take down the turn that asked. Reporting
      // 0 understates reach, which is the safe direction: it never tells the
      // model the user was reachable when they were not.
      return 0;
    }
  }

  addSink(sink: UserNotificationSink): { dispose(): void } {
    this.sinks.add(sink);
    return { dispose: () => this.sinks.delete(sink) };
  }

  /**
   * Clears a conversation's turn budget.
   *
   * Called on turn START, not turn end: a turn that throws or is cancelled
   * never reaches its end, and a counter that leaks would silently mute the
   * agent for every later turn in that conversation.
   */
  resetTurn(conversationId: string | undefined): void {
    const key = conversationId ?? NO_CONVERSATION;
    this.sent.delete(key);
    this.lastSentAt.delete(key);
  }

  /** Remaining notifications right now, after any idle reset has been applied. */
  remaining(conversationId: string | undefined): number {
    return NOTIFY_TURN_LIMIT - this.spent(conversationId ?? NO_CONVERSATION);
  }

  /** Milliseconds until the budget refills, or 0 if it has room already. */
  idleResetIn(conversationId: string | undefined): number {
    const key = conversationId ?? NO_CONVERSATION;
    if (this.spent(key) < NOTIFY_TURN_LIMIT) return 0;
    const elapsed = this.now() - (this.lastSentAt.get(key) ?? 0);
    return Math.max(0, NOTIFY_IDLE_RESET_MS - elapsed);
  }

  /**
   * Notifications charged against the current budget.
   *
   * Reads the clock rather than running a timer: a timer would have to be
   * disposed per conversation, and a leaked one would mute the agent for the
   * rest of the session -- the exact failure `resetTurn` was moved to turn
   * START to avoid.
   */
  private spent(key: string): number {
    const count = this.sent.get(key) ?? 0;
    if (count === 0) return 0;
    const last = this.lastSentAt.get(key);
    if (last !== undefined && this.now() - last >= NOTIFY_IDLE_RESET_MS) return 0;
    return count;
  }

  /**
   * Fans out to every sink; resolves to the total chats queued.
   *
   * A throwing sink counts 0 and is reported rather than rejecting: one broken
   * transport must not take down a notification the other transports, and the
   * local VS Code toast, can still deliver.
   */
  async notify(event: UserNotificationEvent): Promise<number> {
    const key = event.conversationId ?? NO_CONVERSATION;
    // Charge against the post-reset count, so the send that follows a quiet
    // stretch starts a fresh burst instead of landing on a stale total.
    this.sent.set(key, this.spent(key) + 1);
    this.lastSentAt.set(key, this.now());
    return this.fanOut(event);
  }

  /**
   * Delivers a generated image to the conversation's remote chats.
   *
   * Not charged against the notify_user budget: every image already passed a
   * per-call approval, which is a stronger brake than the burst cap, and an
   * agent asked for five images must not lose its ability to notify.
   */
  async deliverImage(event: UserNotificationEvent & { imagePath: string }): Promise<number> {
    return this.fanOut(event);
  }

  private async fanOut(event: UserNotificationEvent): Promise<number> {
    const counts = await Promise.all(
      [...this.sinks].map(async (sink) => {
        try {
          return await sink(event);
        } catch (err) {
          this.onSinkError?.(`Forge notification sink failed: ${(err as Error).message}`);
          return 0;
        }
      }),
    );
    return counts.reduce((total, count) => total + count, 0);
  }
}
