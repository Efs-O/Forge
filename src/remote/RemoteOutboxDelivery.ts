import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel } from './types';

const MAX_ATTEMPTS = 10;
type CanDeliver = (chatId: string) => boolean | Promise<boolean>;

/** One serialized, channel-scoped at-least-once notification delivery loop. */
export class RemoteOutboxDelivery {
  private running: Promise<void> | undefined;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly store: RemoteRequestStore,
    private maxMessageChars: number,
    private readonly signal: AbortSignal,
    private readonly retryDelayMs = 1_000,
    private readonly onError?: (message: string) => void,
    private readonly canDeliver: CanDeliver = () => true,
    /**
     * Optional spoken rendering, attempted AFTER the text is marked delivered.
     * Ordering is the contract: speech must never be able to affect whether a
     * message counts as sent, or a Piper failure would drive the retry loop.
     */
    private readonly speak?: (chatId: string, text: string) => Promise<boolean>,
  ) {}

  start(): void {
    this.stopped = false;
    this.kick();
  }

  updateMaxMessageChars(maxMessageChars: number): void {
    this.maxMessageChars = maxMessageChars;
  }

  kick(): void {
    if (this.stopped || this.running) return;
    this.running = this.deliver()
      .catch((err) =>
        this.onError?.(
          `Forge remote notification delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      .finally(() => {
        this.running = undefined;
        void this.scheduleRetry();
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.running;
  }

  private async deliver(): Promise<void> {
    for (const item of this.store.pendingOutbox(this.channel.name)) {
      if (this.stopped) return;
      if (!(await this.canDeliver(item.chatId))) continue;
      await this.store.markOutbox(item.id, 'sending');
      try {
        await this.channel.send(item.chatId, item.text.slice(0, this.maxMessageChars), {
          signal: this.signal,
        });
        await this.store.markOutbox(item.id, 'delivered');
        // Never inside the try that owns delivery state: `speak` swallows its
        // own errors, but the ordering has to make that impossible to get wrong
        // if it ever stops doing so.
        await this.speak?.(item.chatId, item.text).catch(() => false);
      } catch {
        await this.store.markOutbox(
          item.id,
          item.attempts + 1 >= MAX_ATTEMPTS ? 'abandoned' : 'pending',
        );
        return;
      }
    }
  }

  private async scheduleRetry(): Promise<void> {
    if (this.stopped || this.retryTimer) return;
    try {
      const pending = this.store.pendingOutbox(this.channel.name);
      const next = await this.nextDeliverable(pending);
      if (!next || this.stopped) return;
      const exponent = Math.max(0, Math.min(next.attempts - 1, 6));
      const delay = Math.min(this.retryDelayMs * 2 ** exponent, 60_000);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.kick();
      }, delay);
    } catch (err) {
      this.onError?.(
        `Forge remote notification scheduling failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async nextDeliverable<T extends { chatId: string }>(items: T[]): Promise<T | undefined> {
    for (const item of items) {
      if (await this.canDeliver(item.chatId)) return item;
    }
    return undefined;
  }
}
