import { randomBytes } from 'crypto';
import { getLogger } from '../util/logger';

const log = getLogger();

export const INBOX_CAP = 20;
const BUSY_POLL_MS = 2_000;

export interface InboxMessageOptions {
  model?: string;
  newChat?: boolean;
  /** The bus sender; the host routes its message to the chat it last wrote in. */
  from?: string;
}

/**
 * How a bus-started turn ended. `submit` resolving used to mean "finished",
 * so a turn that was cancelled while queued behind a busy local server, or
 * that failed, reached its sender as `finished` with no answer and no reason.
 */
export interface BusTurnEnd {
  kind: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  /** The failure, for `failed`. */
  error?: string;
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
  /** Start a visible turn with this prompt; resolves with how the turn ended. */
  submit(prompt: string, options?: InboxMessageOptions): Promise<BusTurnEnd>;
  /** Tell the user a message could not be delivered. */
  warn(message: string): void;
  /**
   * Called when a bus-started turn ends (AGENT_MESH_PLAN §9, P1). The sender
   * gets one line saying how it ended and a board event is written. Absent ⇒
   * no notice (a user-typed turn has no bus sender).
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
   * `onBusTurnFinished` (the sender notice, which fires only on success): a
   * failed turn still must not leave a stale "running" status record, but it
   * has no successful turn to report to the sender.
   */
  onBusTurnStatusCleared?(turnId: string): void;
}

interface QueuedMessage {
  /** Returned to the sender so it can withdraw the message (`/agent/cancel`). */
  id: string;
  prompt: string;
  /** The bus sender alias, when the message came through the agent bus. */
  from?: string;
  options?: InboxMessageOptions;
}

/** A queued message's options as the host sees them: with its sender. */
function hostOptions(item: QueuedMessage | undefined): InboxMessageOptions | undefined {
  if (!item?.from) return item?.options;
  return { ...item.options, from: item.from };
}

/**
 * Messages other agents send Forge (`POST /agent/message`). An idle chat gets
 * one at once; a busy one gets it when its turn ends, one turn per message.
 * Memory only, by design: a message is a prompt, and a prompt replayed after a
 * reload the user never saw would act on stale intent. The ledger records the
 * loss ("best effort while busy").
 */
export class AgentInbox {
  private readonly queue: QueuedMessage[] = [];
  private draining = false;
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
    const item = { id, prompt, ...(from ? { from } : {}), ...(options ? { options } : {}) };
    if (front) this.queue.unshift(item);
    else this.queue.push(item);
    void this.drain();
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

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  private busy(options?: InboxMessageOptions): boolean {
    try {
      return this.host.isBusy(options);
    } catch {
      return true; // The chat is not up yet (activation): try again shortly.
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.disposed && this.queue.length > 0) {
        if (this.busy(hostOptions(this.queue[0]))) {
          await new Promise((r) => setTimeout(r, this.pollMs));
          continue;
        }
        const item = this.queue.shift() as QueuedMessage;
        const startedAt = Date.now();
        // F-08: a stable turn id for the status file (start writes it, finish
        // clears it). Only bus turns (a `from` alias) get one; user-typed
        // prompts have no bus sender and no status file.
        const turnId = item.from ? `bus-${item.from}-${startedAt}` : undefined;
        if (turnId && this.host.onBusTurnStarted) {
          try {
            this.host.onBusTurnStarted(turnId);
          } catch (startErr) {
            log.error(`[agentInbox] status mark-start failed: ${String(startErr)}`);
          }
        }
        try {
          const end = await this.host.submit(item.prompt, hostOptions(item));
          // §9: a bus-started turn just ended — the sender gets one line saying
          // how (finished, failed, cancelled) + a board event. A user-typed turn
          // has no `from`, so this fires only for agent messages.
          if (item.from && this.host.onBusTurnFinished) {
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
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
