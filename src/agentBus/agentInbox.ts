import { randomBytes } from 'crypto';
import { getLogger } from '../util/logger';
import type { AgentSenderMetadata } from '../agentLinks/chatAgentLinks';
import { deliveredPrompt, type BusTurnEnd } from './agentInboxPrompt';
import { AgentInboxMidTurn } from './agentInboxMidTurn';
import { AgentInboxScanScheduler } from './agentInboxScanScheduler';
import type {
  ClaimedMidTurnMessage,
  MidTurnQueueItem,
  RunningTurnPolicy,
} from './agentInboxMidTurn';

// The prompt shapes live in `agentInboxPrompt.ts`; re-exported here so the
// queue's own surface stays the one its eleven importers already reach.
export * from './agentInboxPrompt';

const log = getLogger();

export const INBOX_CAP = 20;
const BUSY_POLL_MS = 2_000;

export interface InboxMessageOptions {
  model?: string;
  newChat?: boolean;
  /** A name for the chat a `--new` opens, when the caller has one. The window
   *  applies it to the chat it creates; absent means the window's own title. */
  title?: string;
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
  /** Queue this message but start nothing: the drain skips it until
   *  `release(id)`. A steer uses it because the window's last guard runs
   *  AFTER admission — the queue must not start the turn that guard is
   *  still deciding on. */
  hold?: boolean;
  /**
   * Nobody is watching this turn: dangerous tools are refused at once with a
   * reason instead of raising an approval dialog that would hang it. Any other
   * action that needs approval is refused unless its approval key is listed in
   * `approvals.unattended_bus.allow` in `~/.forge/policy.yaml` (the refusal
   * names the key); only a confirmation with no approval key is approved
   * automatically.
   */
  unattended?: boolean;
  /** Job identity carried with an unattended peer-delivered turn. */
  jobId?: string;
  jobName?: string;
}

export type { ClaimedMidTurnMessage, RunningTurnPolicy } from './agentInboxMidTurn';

export type { ChatTargetSelection, ChatTargetResult } from './busTarget';

export type ForgeSteerResult =
  | { steered: true; conversationId: string; title: string }
  /** `blocked` is not "it was idle": the window refused to interrupt, usually
   *  because the owner is being asked something, so the route withdraws the
   *  message it had queued and answers a refusal the sender can retry. */
  | { steered: false; reason: string; blocked?: boolean };

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

interface QueuedMessage extends MidTurnQueueItem {
  /** Returned to the sender so it can withdraw the message (`/agent/cancel`). */
  id: string;
  prompt: string;
  /** The sender name, when the message came through the agent bus. */
  from?: string;
  options?: InboxMessageOptions;
  /** A steer interrupts the turn and runs as its own; never claimed mid-turn. */
  steer?: boolean;
  /** The drain skips this message until `release(id)` clears the hold. */
  hold?: boolean;
  /** When the sender wrote it; delivery can come much later. */
  queuedAt: number;
}

/** A queued message's options as the host sees them: with its sender. */
function hostOptions(item: MidTurnQueueItem | undefined): InboxMessageOptions | undefined {
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
  private readonly midTurn = new AgentInboxMidTurn();
  private readonly scanScheduler = new AgentInboxScanScheduler(
    () => this.disposed,
    () => this.runScan(),
  );
  /** Chats with a turn this inbox started that has not settled. */
  private readonly inFlight = new Set<string>();
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
      ...(options?.hold ? { hold: true } : {}),
    };
    if (front) this.queue.unshift(item);
    else this.queue.push(item);
    this.midTurn.signal(item, hostOptions);
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
    if (removed > 0) {
      // Removing a held steer unblocks the lane it was holding: a follow-up
      // waiting behind it needs a pass now, not at the next unrelated event.
      this.scheduleScan();
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

  /** Signal claimable queued messages without claiming or removing them. */
  onClaimableMidTurnAdded(
    conversationId: string,
    targetOf: (options?: InboxMessageOptions) => string,
    runningTurn: () => RunningTurnPolicy,
    callback: () => void,
  ): () => void {
    return this.midTurn.add(
      conversationId,
      targetOf,
      runningTurn,
      callback,
      this.queue,
      hostOptions,
    );
  }

  /**
   * Clear a `hold: true` message's hold so the drain may start it, and say
   * whether such a message was still queued. The route that accepted a steer
   * releases it only once its last guard has passed — until then the queue
   * cannot start a turn the guard is still deciding on, so a refusal after
   * admission is a guaranteed withdrawal (`cancel` removes the held message).
   */
  release(id: string): boolean {
    return this.midTurn.release(this.queue, id, hostOptions, () => this.scheduleScan());
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
   * `--new` or `--model` message still needs a turn of its own and keeps
   * waiting, and a held message waits for its release. An `--unattended`
   * message joins only a running turn that is itself unattended under the same
   * job identity (both without a job, or the same `jobId`): merged into an
   * attended turn, a dangerous tool would raise an approval card nobody
   * answers, and merged into another job's turn it would run under that job's
   * allow rules. A claimed sender carries its options so its pending reply can
   * start here and settle when this chat's request chain ends. `targetOf`
   * resolves the chat a message belongs in; `runningTurn` is that chat's
   * unattended state.
   */
  claimMidTurn(
    conversationId: string,
    targetOf: (options?: InboxMessageOptions) => string,
    runningTurn: RunningTurnPolicy,
  ): ClaimedMidTurnMessage[] {
    return this.midTurn.claim(
      this.queue,
      conversationId,
      targetOf,
      runningTurn,
      (item) => deliveredPrompt(item, Date.now()),
      hostOptions,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.midTurn.clear();
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
    this.scanScheduler.schedule();
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
      if (item.hold) {
        // Held back until the route's last guard passes. Its lane blocks too,
        // so nothing queued later can slip into that chat ahead of the steer.
        const heldLane = this.laneOf(item);
        if (heldLane !== undefined) blocked.add(heldLane);
        continue;
      }
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
