import { remoteDedupKey } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundEvent } from './types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

export interface CommandCleanupSchedulerDeps {
  channel: RemoteChannel;
  signal: AbortSignal;
  /**
   * Live read of `remote.delete_command_messages_after`, so a config reload
   * changes the delay for subsequently received commands without a window
   * reload. `0` (or absent) disables cleanup.
   */
  delaySeconds: () => number;
  /** Stable across reloads; reports a failed delete without affecting the command. */
  onError?: ((message: string) => void) | undefined;
}

/**
 * Schedules the best-effort deletion of a processed owner command message from
 * Telegram after a configurable delay.
 *
 * Extracted from `RemoteController` (which sits at its line-count lint limit)
 * so the timer bookkeeping has a single owner and can be tested in isolation.
 * The delete is detached from the command path: it fires later on a timer, and
 * a failure is swallowed and reported only through `onError`, so it can never
 * alter command execution.
 */
export class CommandCleanupScheduler {
  private readonly pending = new Set<ReturnType<typeof setTimeout>>();
  /**
   * Dedup keys already armed or fired. Kept after firing so a redelivered
   * update cannot issue a second delete for the same message.
   */
  private readonly armed = new Set<string>();

  constructor(private readonly deps: CommandCleanupSchedulerDeps) {}

  schedule(event: TextEvent): void {
    const delaySeconds = this.deps.delaySeconds();
    if (delaySeconds <= 0) return;
    if (!this.deps.channel.deleteMessage) return;
    const key = remoteDedupKey(event.channel, event.chatId, event.providerMessageId);
    if (this.armed.has(key)) return;
    this.armed.add(key);
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      if (this.deps.signal.aborted) return;
      void (async () => {
        let message: string;
        try {
          await this.deps.channel.deleteMessage!(event.chatId, event.providerMessageId, {
            signal: this.deps.signal,
          });
          return;
        } catch (err) {
          message = `Forge Telegram command auto-delete failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
        // Report the failure; a throwing onError must not escape the timer
        // as an unhandled rejection.
        try {
          this.deps.onError?.(message);
        } catch {
          // Best-effort: the delete already failed; a broken reporter is
          // not a reason to crash the process.
        }
      })();
    }, delaySeconds * 1000);
    this.pending.add(timer);
  }

  /** Cancels any still-pending deletes; called from the controller's stop(). */
  dispose(): void {
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
    this.armed.clear();
  }
}
