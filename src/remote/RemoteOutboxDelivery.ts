import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel } from './types';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteSpeechDelivery } from './RemoteSpeechDelivery';
import type { RemoteControllerOptions } from './remoteControllerOptions';
import type { CommandCleanupScheduler } from './CommandCleanupScheduler';
import { recordSessionQuestionMessages } from './RemoteSessionBridge';

const MAX_ATTEMPTS = 10;
type CanDeliver = (chatId: string) => boolean | Promise<boolean>;

export function createRemoteOutboxDelivery(input: {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  auth: RemoteAuth;
  signal: AbortSignal;
  options: RemoteControllerOptions;
  speech?: RemoteSpeechDelivery | undefined;
  commandCleanup: CommandCleanupScheduler;
}): RemoteOutboxDelivery {
  const { channel, store, auth, signal, options, speech, commandCleanup } = input;
  return new RemoteOutboxDelivery(
    channel,
    store,
    options.maxMessageChars,
    signal,
    1_000,
    options.onError,
    (chatId) => auth.canDeliver(channel.name, chatId),
    speech ? (chatId, text) => speech.speak(chatId, text) : undefined,
    (chatId, messageIds) => commandCleanup.armEphemeral(chatId, messageIds),
  );
}

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
    /**
     * Optional best-effort cleanup of a delivered ephemeral message (e.g. a
     * "model unloaded" broadcast). Called AFTER the item is marked delivered
     * and OUTSIDE the send/retry path, so a failure here can never requeue an
     * already-delivered item.
     */
    private readonly armEphemeral?: (chatId: string, messageIds: string[]) => void,
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
      let sentIds: string[] | void;
      try {
        sentIds = await this.channel.send(item.chatId, item.text.slice(0, this.maxMessageChars), {
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
      // Same rule: a failed record only costs reply-to-answer; /answer <id> still works.
      await recordSessionQuestionMessages(this.store, item.id, sentIds ?? []).catch((err) =>
        this.onError?.(`Forge could not record a session question's messages: ${String(err)}`),
      );
      // Best-effort, and OUTSIDE the try that owns delivery state: an
      // already-delivered item must never be requeued because arming its
      // ephemeral cleanup failed.
      if (item.ephemeral && this.armEphemeral) {
        try {
          this.armEphemeral(item.chatId, sentIds ?? []);
        } catch (err) {
          try {
            this.onError?.(
              `Forge remote ephemeral notification cleanup failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          } catch {
            // Best-effort: the item is already delivered; a broken reporter
            // must not reject deliver() or disrupt subsequent deliveries.
          }
        }
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
