import { compactionAggregationText, remoteCompactionNotice } from './remoteCompactionNotice';
import type { CompactionEvent } from '../sidebar/CompactionService';
import type { RemoteController } from './RemoteController';

/**
 * Buffers completed auto-compactions per conversation and flushes them as ONE
 * aggregated message, instead of one message per compaction.
 *
 * A long unattended run can auto-compact several times; sending
 * "compaction complete." after each was pure noise on the phone. This collects
 * the count and emits a single line ("Forge: N compactions complete.") when:
 * - the reset timer fires (no further compaction within `flushDelayMs`), or
 * - the next conversation-scoped notification is about to be enqueued (turn
 *   echo, failure, notify_user) — the pre-notify flush keeps the summary
 *   ahead of the answer it would otherwise overtake.
 *
 * The buffer is per-controller (per transport) and per-conversation within it:
 * Telegram and WhatsApp can observe the same conversation concurrently, and two
 * conversations on one transport must not merge their counts.
 *
 * Disposal drops any pending count: the buffer is a display convenience, not a
 * durable obligation. If the transport stops with a count still buffered, the
 * user sees the state in the token bar or on reconnect.
 */
export class CompactionNoticeBuffer {
  private readonly counts = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly flushes = new Map<string, Promise<string | undefined>>();
  private disposed = false;

  constructor(
    private readonly deliver: (conversationId: string, text: string) => Promise<unknown>,
    private readonly onError: (message: string) => void,
    private readonly flushDelayMs: number = 3000,
  ) {}

  /** Record a completed auto-compaction; resets the flush timer for that conversation. */
  record(conversationId: string): void {
    if (this.disposed) return;
    this.counts.set(conversationId, (this.counts.get(conversationId) ?? 0) + 1);
    const existing = this.timers.get(conversationId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      conversationId,
      setTimeout(() => {
        void this.flush(conversationId);
      }, this.flushDelayMs),
    );
  }

  /**
   * Flush the pending count for a conversation, sending the aggregated message.
   * Resolves to the text sent, or undefined when nothing was pending.
   */
  async flush(conversationId: string): Promise<string | undefined> {
    if (this.disposed) return undefined;
    const previous = this.flushes.get(conversationId) ?? Promise.resolve(undefined);
    const current = previous.then(async () => {
      let lastText: string | undefined;
      // A record can arrive while delivery is awaiting the durable outbox
      // write. Keep the same conversation serialized so its next notification
      // cannot overtake that second batch either.
      for (;;) {
        if (this.disposed) return lastText;
        const timer = this.timers.get(conversationId);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(conversationId);
        }
        const count = this.counts.get(conversationId);
        if (!count) return lastText;
        this.counts.delete(conversationId);
        const text = compactionAggregationText(count);
        try {
          await this.deliver(conversationId, text);
        } catch (err) {
          this.onError((err as Error).message);
        }
        lastText = text;
      }
    });
    const tracked = current.finally(() => {
      if (this.flushes.get(conversationId) === tracked) this.flushes.delete(conversationId);
    });
    this.flushes.set(conversationId, tracked);
    return tracked;
  }

  /** Clear all timers and drop pending counts. Idempotent. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.counts.clear();
  }
}

/** Owns one aggregation buffer per live remote controller. */
export class RemoteCompactionNoticeBuffers {
  private readonly buffers = new Map<RemoteController, CompactionNoticeBuffer>();
  private readonly stoppedControllers = new WeakSet<RemoteController>();

  constructor(private readonly notifyLocal: (message: string) => void) {}

  onCompactionEvent(event: CompactionEvent, controller: RemoteController): void {
    if (this.stoppedControllers.has(controller)) return;
    if (event.trigger !== 'auto' || event.phase !== 'finished') return;
    if (event.outcome === 'skipped') return;
    const buffer = this.bufferFor(controller);
    if (event.outcome === 'compacted') {
      buffer.record(event.conversationId);
      return;
    }
    const text = remoteCompactionNotice(event);
    if (text === undefined) return;
    void (async () => {
      await buffer.flush(event.conversationId);
      if (this.stoppedControllers.has(controller)) return;
      await controller.enqueueHostNotification(event.conversationId, text);
    })().catch((err) => {
      this.notifyLocal(`Forge remote compaction notification failed: ${(err as Error).message}`);
    });
  }

  async beforeConversationNotify(
    controller: RemoteController,
    conversationId: string,
  ): Promise<void> {
    await this.buffers.get(controller)?.flush(conversationId);
  }

  onTransportStopped(controller: RemoteController): void {
    this.stoppedControllers.add(controller);
    this.buffers.get(controller)?.dispose();
    this.buffers.delete(controller);
  }

  private bufferFor(controller: RemoteController): CompactionNoticeBuffer {
    let buffer = this.buffers.get(controller);
    if (!buffer) {
      buffer = new CompactionNoticeBuffer(
        (conversationId, text) => controller.enqueueHostNotification(conversationId, text),
        (message) => this.notifyLocal(`Forge remote compaction notification failed: ${message}`),
      );
      this.buffers.set(controller, buffer);
    }
    return buffer;
  }
}
