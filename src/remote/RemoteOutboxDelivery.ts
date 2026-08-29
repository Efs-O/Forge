import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel } from './types';

const MAX_ATTEMPTS = 10;

/** One serialized, channel-scoped at-least-once notification delivery loop. */
export class RemoteOutboxDelivery {
  private running: Promise<void> | undefined;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly store: RemoteRequestStore,
    private readonly maxMessageChars: number,
    private readonly signal: AbortSignal,
    private readonly retryDelayMs = 1_000,
    private readonly onError?: (message: string) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.kick();
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
        const pending = this.store.pendingOutbox(this.channel.name);
        if (!this.stopped && pending.length > 0) {
          const exponent = Math.max(0, Math.min((pending[0]?.attempts ?? 1) - 1, 6));
          const delay = Math.min(this.retryDelayMs * 2 ** exponent, 60_000);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.kick();
          }, delay);
        }
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
      await this.store.markOutbox(item.id, 'sending');
      try {
        await this.channel.send(item.chatId, item.text.slice(0, this.maxMessageChars), {
          signal: this.signal,
        });
        await this.store.markOutbox(item.id, 'delivered');
      } catch {
        await this.store.markOutbox(
          item.id,
          item.attempts + 1 >= MAX_ATTEMPTS ? 'abandoned' : 'pending',
        );
        return;
      }
    }
  }
}
