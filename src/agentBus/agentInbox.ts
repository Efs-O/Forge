import { randomBytes } from 'crypto';
import { getLogger } from '../util/logger';
import type { AgentSenderMetadata } from '../agentLinks/chatAgentLinks';

const log = getLogger();

export const INBOX_CAP = 20;
const BUSY_POLL_MS = 2_000;

export interface InboxMessageOptions {
  model?: string;
  newChat?: boolean;
  sender?: AgentSenderMetadata;
  pendingReplyId?: string;
  /** The bus sender; the host routes its message to the chat it last wrote in. */
  from?: string;
  /** A sender-selected Forge conversation, resolved by the host before queuing. */
  targetConversationId?: string;
  /** Request selection of the currently running Forge conversation. */
  toRunning?: boolean;
  /** A sender-selected conversation before host-side resolution. */
  conversationId?: string;
  /**
   * Nobody is watching this turn: dangerous tools are refused at once instead
   * of raising an approval dialog that would hang it, and other confirmations
   * are auto-approved — the same policy a job run gets.
   */
  unattended?: boolean;
}

export interface ClaimedMidTurnMessage {
  content: string;
  options?: InboxMessageOptions;
}

export interface ChatTargetSelection {
  conversationId?: string;
  toRunning?: boolean;
}

export type ChatTargetResult =
  | { ok: true; conversationId: string; title: string }
  | { ok: false; status?: 400 | 404 | 409; error: string };

export type ForgeSteerResult =
  | { steered: true; conversationId: string; title: string }
  | { steered: false; reason: string };

/**
 * How a bus-started turn ended. `submit` resolving used to mean "finished",
 * so a turn that was cancelled while queued behind a busy local server, or
 * that failed, reached its sender as `finished` with no answer and no reason.
 */
export interface BusTurnEnd {
  kind: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  /** The failure, for `failed`. */
  error?: string;
  finalText?: string;
}

/** The sender's one line for how its turn ended. Only `completed` says finished. */
export function busTurnEndLine(end: BusTurnEnd, durationMs: number): string {
  const took =
    durationMs < 60_000
      ? `${Math.max(1, Math.round(durationMs / 1000))} s`
      : `${Math.round(durationMs / 60_000)} min`;
  switch (end.kind) {
    case 'completed':
      return `finished · ${took} · the turn you started has ended`;
    case 'failed':
      return `failed · ${took} · the turn you started ended with an error: ${end.error ?? 'unknown error'}`;
    case 'cancelled':
      return `cancelled · ${took} · the turn you started was stopped before it answered`;
    case 'interrupted':
      return `interrupted · ${took} · the turn you started was interrupted before it answered`;
  }
}

/** What the inbox needs from Forge's chat. */
export interface InboxHost {
  /** True while the chat a message would land in is mid-turn, or not ready. */
  isBusy(options?: InboxMessageOptions): boolean;
  /**
   * The chat this message will run in — the line its place in queue is drawn
   * on. The wiring answers through `busTarget`, the single owner of that
   * decision, so the inbox never guesses a chat. `undefined` for a `--new`
   * message: it has no chat yet and creates its own, so it shares no line and
   * never waits on another chat's turn. A throw means the chat cannot be named
   * yet (activation), which is treated as busy.
   */
  laneOf(options?: InboxMessageOptions): string | undefined;
  /** Start a visible turn with this prompt; resolves with how the turn ended. */
  submit(prompt: string, options?: InboxMessageOptions): Promise<BusTurnEnd>;
  /** Tell the user a message could not be delivered. */
  warn(message: string): void;
  /**
   * Called when a bus-started turn ends (AGENT_MESH_PLAN §9, P1). The sender
   * gets one line saying how it ended and a board event is written. Absent ⇒
   * no notice (a user-typed turn has no bus sender). Also fires when `submit`
   * itself threw — a turn that never started still has a sender waiting on an
   * answer, and a silent drop is the one outcome that cannot be recovered from.
   */
  onBusTurnFinished?(from: string, durationMs: number, end: BusTurnEnd): void;
  /**
   * Called when a bus-started turn BEGINS (F-08). The wiring writes a durable
   * status file so a crashed turn can be detected at the next window's startup.
   */
  onBusTurnStarted?(turnId: string): void;
  /**
   * Called when a bus-started turn ENDS, on EVERY exit (success or failure)
   * (F-08). The wiring clears the turn's status file. This is distinct from
   * `onBusTurnFinished` (the sender notice): a failed turn still must not leave
   * a stale "running" status record, even when the sender is only told it failed.
   */
  onBusTurnStatusCleared?(turnId: string): void;
  onAgentTurnStarted?(options: InboxMessageOptions): void | Promise<void>;
  onAgentTurnFinished?(options: InboxMessageOptions, end: BusTurnEnd): void | Promise<void>;
  /** A queued message of this sender was withdrawn before it started. May
   *  record the withdrawal; the queue does not wait for it.
   */
  onAgentTurnCancelled?(options: InboxMessageOptions): void | Promise<void>;
}

interface QueuedMessage {
  /** Returned to the sender so it can withdraw the message (`/agent/cancel`). */
  id: string;
  prompt: string;
  /** The sender name, when the message came through the agent bus. */
  from?: string;
  options?: InboxMessageOptions;
  /** A steer interrupts the turn and runs as its own; never claimed mid-turn. */
  steer?: boolean;
  /** When the sender wrote it; delivery can come much later. */
  queuedAt: number;
}

/** Waits shorter than this are ordinary queueing and say nothing. */
export const STALE_NOTE_AFTER_MS = 60_000;

/**
 * A bus message's prompt as delivered. One that sat in the queue gets its age
 * appended: a "redo 70K/120K" queued while Forge was blocked on a question
 * reached it after the sender's newer "no redo" reply, and with nothing
 * showing the order the agent read delivery order as authorship order and
 * started the withdrawn redo. The note sits after the agent-bus trailer, so
 * `parseForgeInboundPrompt` strips it from remote views.
 */
export function deliveredPrompt(
  item: Pick<QueuedMessage, 'prompt' | 'from' | 'queuedAt'>,
  now: number,
): string {
  const waited = now - item.queuedAt;
  if (!item.from || waited < STALE_NOTE_AFTER_MS) return item.prompt;
  const sent = new Date(item.queuedAt).toTimeString().slice(0, 8);
  const mins = Math.round(waited / 60_000);
  return (
    `${item.prompt}\n\n_(Queued: ${item.from} wrote this at ${sent}, ${mins} min before it ` +
    `reached you. Anything ${item.from} told you after that, including an answer to your ` +
    `question, is newer and overrides it.)_`
  );
}

/** A queued message's options as the host sees them: with its sender. */
function hostOptions(item: QueuedMessage | undefined): InboxMessageOptions | undefined {
  if (!item?.from) return item?.options;
  return { ...item.options, from: item.from };
}

/**
 * Messages other agents send Forge (`POST /agent/message`). Each chat's
 * messages run one turn at a time, in order; a message waits only on its own
 * chat, so two chats run at once and a long turn in one no longer delays a
 * message addressed to another. Queued prompts stay in memory so a reload
 * never replays stale intent. A session-bound message separately has a durable
 * pending-reply record for crash recovery; the exchange ledger records ordinary
 * queue outcomes.
 */
export class AgentInbox {
  private readonly queue: QueuedMessage[] = [];
  /** Chats with a turn this inbox started that has not settled. */
  private readonly inFlight = new Set<string>();
  private scanning = false;
  private rescanRequested = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly host: InboxHost,
    private readonly pollMs: number = BUSY_POLL_MS,
  ) {}

  /**
   * Queue a prompt; returns its place in line and its id, or undefined when
   * full. A steer (`front`) jumps the line so it runs as soon as the
   * interrupted turn ends.
   */
  accept(
    prompt: string,
    from?: string,
    front = false,
    options?: InboxMessageOptions,
  ): { position: number; id: string } | undefined {
    if (this.disposed || this.queue.length >= INBOX_CAP) return undefined;
    const id = `m${randomBytes(4).toString('hex')}`;
    const item: QueuedMessage = {
      id,
      prompt,
      queuedAt: Date.now(),
      ...(from ? { from } : {}),
      ...(options ? { options } : {}),
      ...(front ? { steer: true } : {}),
    };
    if (front) this.queue.unshift(item);
    else this.queue.push(item);
    this.scheduleScan();
    return { position: front ? 1 : this.queue.length, id };
  }

  /**
   * Withdraw `from`'s queued message `id`, or all of them (`'all'`); returns
   * how many were removed. Only messages that have not started: a running one
   * is shifted off the queue already, and interrupting it is what a steer is
   * for (MESH_RUN_1_FINDINGS F3). A sender can never cancel another's message.
   */
  cancel(from: string, id: string): number {
    let removed = 0;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const item = this.queue[i] as QueuedMessage;
      if (item.from !== from || (id !== 'all' && item.id !== id)) continue;
      this.queue.splice(i, 1);
      if (item.options?.sender) this.host.onAgentTurnCancelled?.(item.options);
      removed++;
    }
    return removed;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** How many of `from`'s messages are queued and not yet started. */
  pendingFrom(from: string): number {
    return this.queue.filter((item) => item.from === from).length;
  }

  /**
   * The chat `from`'s next accepted-but-not-yet-started message will run in:
   * the one it was routed into when it was accepted, or undefined when that
   * message is a `--new` one, which has no chat until it starts (and undefined
   * when `from` has nothing queued).
   *
   * The read routes need this because an accepted message is not an exchange
   * yet: `status` and `view` resolved a sender only from recorded exchanges and
   * chat titles, so a sender's very first message — the one that earned the
   * 202 it is waiting on — answered `no chat holds a message`, and
   * `forge.sh wait` gave up on a queue it had been told existed (audit F3).
   * The first match is the message the queue takes first, so a `--new` message
   * ahead of a routed one reports no chat even though a later message names one.
   */
  queuedTargetConversation(from: string): string | undefined {
    return this.queue.find((item) => item.from === from)?.options?.targetConversationId;
  }

  /**
   * Take the messages waiting on `conversationId` for its running turn's next
   * tool-round gap. Waiting for the turn to end starved a long agentic turn:
   * a refactor ran for hours as one turn and a message sat queued throughout,
   * while a Telegram or typed message reached it at the next round. A steer,
   * `--new`, `--model` or `--unattended` message still needs a turn of its own
   * and keeps waiting. A claimed sender carries its options so its pending
   * reply can start here and settle when this chat's request chain ends.
   * `targetOf` resolves the chat a message belongs in.
   */
  claimMidTurn(
    conversationId: string,
    targetOf: (options?: InboxMessageOptions) => string,
  ): ClaimedMidTurnMessage[] {
    const claimed: ClaimedMidTurnMessage[] = [];
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i] as QueuedMessage;
      if (item.steer || item.options?.newChat || item.options?.model || item.options?.unattended) {
        continue;
      }
      const options = hostOptions(item);
      if (targetOf(options) !== conversationId) continue;
      claimed.push({
        content: deliveredPrompt(item, Date.now()),
        ...(options ? { options } : {}),
      });
      this.queue.splice(i--, 1);
    }
    return claimed;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private busy(options?: InboxMessageOptions): boolean {
    try {
      return this.host.isBusy(options);
    } catch {
      return true; // The chat is not up yet (activation): try again shortly.
    }
  }

  /**
   * One dispatch pass at a time. `scanning` rather than the old `draining`: a
   * pass is synchronous, so nothing can queue itself into the middle of one,
   * and a `cancel`, `claimMidTurn` or `accept` that lands inside a pass still
   * gets the pass it deserves (`rescanRequested`).
   */
  private scheduleScan(): void {
    if (this.disposed) return;
    if (this.scanning) {
      this.rescanRequested = true;
      return;
    }
    this.scanning = true;
    try {
      this.runScan();
    } finally {
      this.scanning = false;
    }
    if (this.rescanRequested) {
      this.rescanRequested = false;
      this.scheduleScan();
    }
  }

  /**
   * The line this message belongs to: the chat it will run in, asked from the
   * host through `busTarget`. A `--new` message has no chat yet and creates
   * its own, so it gets a lane of one — two `--new` messages neither share a
   * chat nor wait on each other. `undefined` means the host cannot name the
   * chat yet, and nothing can start this pass.
   */
  private laneOf(item: QueuedMessage): string | undefined {
    const options = hostOptions(item);
    let lane: string | undefined;
    try {
      lane = this.host.laneOf(options);
    } catch {
      return undefined; // The chat is not up yet (activation): try again shortly.
    }
    if (lane !== undefined) return lane;
    return options?.newChat ? `new:${item.id}` : undefined;
  }

  /**
   * Start everything that can start, in queue order. The first message of a
   * chat that cannot run — a turn is already going there, or the chat is
   * mid-turn for a prompt the user typed — holds back every later message for
   * that chat, which is what "same chat, in order" means; the walk then keeps
   * going and starts the other chats' messages. That is the fix: the old loop
   * stopped at the first busy chat whatever chat it belonged to, so a 30-minute
   * turn in one chat made a message addressed to another wait 30 minutes.
   */
  private runScan(): void {
    const blocked = new Set<string>();
    let waitingOnSomeoneElse = false;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.disposed) return;
      const item = this.queue[i] as QueuedMessage;
      const lane = this.laneOf(item);
      if (lane === undefined) {
        // No chat named yet. Starting a later message out of order is worse
        // than waiting: this is the activation window, where nothing works.
        waitingOnSomeoneElse = true;
        break;
      }
      if (blocked.has(lane)) continue; // An earlier message for this chat is still waiting.
      if (this.inFlight.has(lane)) {
        blocked.add(lane);
        continue; // This inbox already has a turn running in that chat.
      }
      if (this.busy(hostOptions(item))) {
        blocked.add(lane);
        waitingOnSomeoneElse = true;
        continue; // A prompt the user typed, or the chat is not up yet.
      }
      this.queue.splice(i, 1);
      i--; // Whatever took this slot is still unexamined.
      blocked.add(lane);
      this.inFlight.add(lane);
      void this.runItem(item, lane);
    }
    // Only a turn this inbox did not start needs polling: a lane that frees up
    // schedules its own rescan, so a long bus turn no longer polls the sidebar
    // every 2 s the way the old loop did while it awaited `submit`.
    if (!this.disposed && this.queue.length > 0 && waitingOnSomeoneElse && !this.pollTimer) {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        this.scheduleScan();
      }, this.pollMs);
    }
  }

  /** What the old loop did with one item, now for one lane at a time. */
  private async runItem(item: QueuedMessage, lane: string): Promise<void> {
    const startedAt = Date.now();
    // F-08: a stable turn id for the status file (start writes it, finish
    // clears it). Only bus turns (a `from` sender name) get one; user-typed
    // prompts have no bus sender and no status file. The message id is in it
    // because two turns from one sender can now start in the same millisecond
    // in two different chats, and `bus-<from>-<startedAt>` alone would have
    // been the same record for both — the second clear would erase the first
    // turn's still-running record.
    const turnId = item.from ? `bus-${item.from}-${startedAt}-${item.id}` : undefined;
    if (turnId && this.host.onBusTurnStarted) {
      try {
        this.host.onBusTurnStarted(turnId);
      } catch (startErr) {
        log.error(`[agentInbox] status mark-start failed: ${String(startErr)}`);
      }
    }
    try {
      const options = hostOptions(item);
      if (options?.sender) await this.host.onAgentTurnStarted?.(options);
      const end = await this.host.submit(deliveredPrompt(item, startedAt), options);
      if (options?.sender) await this.host.onAgentTurnFinished?.(options, end);
      // §9: a bus-started turn just ended — the sender gets one line saying
      // how (finished, failed, cancelled) + a board event. A user-typed turn
      // has no `from`, so this fires only for agent messages.
      if (item.from && !options?.sender && this.host.onBusTurnFinished) {
        try {
          this.host.onBusTurnFinished(item.from, Date.now() - startedAt, end);
        } catch (notifyErr) {
          log.error(`[agentInbox] finished notice failed: ${String(notifyErr)}`);
        }
      }
    } catch (err) {
      if (this.busy(hostOptions(item))) {
        // Lost a race with a prompt the user typed: keep its place.
        this.queue.unshift(item);
      } else {
        const why = err instanceof Error ? err.message : String(err);
        log.error(`[agentInbox] could not deliver an agent message: ${why}`);
        this.host.warn(`Forge: an agent message could not be shown: ${why}`);
        if (item.options?.sender) {
          try {
            await this.host.onAgentTurnFinished?.(item.options, {
              kind: 'failed',
              error: why,
            });
          } catch (deliveryError) {
            const detail =
              deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
            log.error(`[agentInbox] durable agent reply remains pending: ${detail}`);
            this.host.warn(`Forge: agent reply delivery failed: ${detail}`);
          }
        }
        // The item is still dropped — a prompt replayed after the user
        // fixes the cap is stale intent — but the sender is told, in the
        // same shape it is told for every other failed turn. Without this
        // the route's earlier 202 is the only thing the sender ever sees:
        // `submit` never resolved, so no `onBusTurnFinished` ran and the
        // message vanished with only a window-modal toast as evidence.
        if (item.from && !item.options?.sender && this.host.onBusTurnFinished) {
          try {
            this.host.onBusTurnFinished(item.from, Date.now() - startedAt, {
              kind: 'failed',
              error: why,
            });
          } catch (notifyErr) {
            log.error(`[agentInbox] failure notice failed: ${String(notifyErr)}`);
          }
        }
      }
    } finally {
      // F-08: clear the status file on EVERY exit (success or failure) so a
      // normal finish never leaves a stale "running" record. Only a crash
      // (process death) leaves one, and that is what the startup sweep
      // detects.
      if (turnId && this.host.onBusTurnStatusCleared) {
        try {
          this.host.onBusTurnStatusCleared(turnId);
        } catch (clearErr) {
          log.error(`[agentInbox] status clear failed: ${String(clearErr)}`);
        }
      }
      // The chat is free the moment its turn ends, so the next message for it
      // starts now; a message for another chat never waited for this one.
      this.inFlight.delete(lane);
      if (!this.disposed) this.scheduleScan();
    }
  }
}
