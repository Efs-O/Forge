import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel } from './types';

const MAX_ATTEMPTS = 10;

/** One serialized, channel-scoped at-least-once notification delivery loop. */
export class RemoteOutboxDelivery {
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly store: RemoteRequestStore,
    private readonly maxMessageChars: number,
    private readonly signal: AbortSignal,
    private readonly retryDelayMs = 1_000,
  ) {}

  start(): void {
    this.stopped = false;
    this.kick();
  }

  kick(): void {
    if (this.stopped || this.running) return;
    this.running = this.deliver().finally(() => {
      this.running = undefined;
      if (!this.stopped && this.store.pendingOutbox(this.channel.name).length > 0) {
        setTimeout(() => this.kick(), this.retryDelayMs);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
