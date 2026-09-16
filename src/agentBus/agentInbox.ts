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
}

/**
 * Messages other agents send Forge (`POST /agent/message`). An idle chat gets
 * one at once; a busy one gets it when its turn ends, one turn per message.
 * Memory only, by design: a message is a prompt, and a prompt replayed after a
 * reload the user never saw would act on stale intent. The ledger records the
 * loss ("best effort while busy").
 */
export class AgentInbox {
  private readonly queue: string[] = [];
  private draining = false;
  private disposed = false;

  constructor(
    private readonly host: InboxHost,
    private readonly pollMs: number = BUSY_POLL_MS,
  ) {}

  /** Queue a prompt; returns its place in line, or undefined when full. */
  accept(prompt: string): number | undefined {
    if (this.disposed || this.queue.length >= INBOX_CAP) return undefined;
    this.queue.push(prompt);
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
        const prompt = this.queue.shift() as string;
        try {
          await this.host.submit(prompt);
        } catch (err) {
          if (this.busy()) {
            // Lost a race with a prompt the user typed: keep its place.
            this.queue.unshift(prompt);
            continue;
          }
          const why = err instanceof Error ? err.message : String(err);
          log.error(`[agentInbox] could not deliver an agent message: ${why}`);
          this.host.warn(`Forge: an agent message could not be shown: ${why}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
