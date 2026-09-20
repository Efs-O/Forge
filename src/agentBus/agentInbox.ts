import { getLogger } from '../util/logger';

const log = getLogger();

export const INBOX_CAP = 20;
const BUSY_POLL_MS = 2_000;

/** What the inbox needs from Forge's chat. */
export interface InboxHost {
  /** True while the chat a message would land in is mid-turn, or not ready. */
  isBusy(): boolean;
  /** Start a visible turn with this prompt; resolves when the turn ends. */
  submit(prompt: string): Promise<void>;
  /** Tell the user a message could not be delivered. */
  warn(message: string): void;
  /**
   * Called when a bus-started turn ends (AGENT_MESH_PLAN §9, P1). The sender
   * gets one `finished · …` line and a board event is written. Absent ⇒ no
   * finished notice (a user-typed turn has no bus sender).
   */
  onBusTurnFinished?(from: string, durationMs: number): void;
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
  prompt: string;
  /** The bus sender alias, when the message came through the agent bus. */
  from?: string;
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

  /** Queue a prompt; returns its place in line, or undefined when full. */
  accept(prompt: string, from?: string): number | undefined {
    if (this.disposed || this.queue.length >= INBOX_CAP) return undefined;
    this.queue.push({ prompt, ...(from ? { from } : {}) });
    void this.drain();
    return this.queue.length;
  }

  get pending(): number {
    return this.queue.length;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  private busy(): boolean {
    try {
      return this.host.isBusy();
    } catch {
      return true; // The chat is not up yet (activation): try again shortly.
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.disposed && this.queue.length > 0) {
        if (this.busy()) {
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
          await this.host.submit(item.prompt);
          // §9: a bus-started turn just ended — the sender gets one finished
          // line + a board event. A user-typed turn has no `from`, so this
          // fires only for agent messages, and only on success.
          if (item.from && this.host.onBusTurnFinished) {
            try {
              this.host.onBusTurnFinished(item.from, Date.now() - startedAt);
            } catch (notifyErr) {
              log.error(`[agentInbox] finished notice failed: ${String(notifyErr)}`);
            }
          }
        } catch (err) {
          if (this.busy()) {
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
