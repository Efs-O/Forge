import { remoteDedupKey } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundEvent } from './types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

/**
 * Commands whose reply is content, not an acknowledgement: `/view` re-sends
 * earlier agent answers, and deleting those after seconds defeats the command.
 */
const KEEP_REPLIES_OF = new Set(['/view']);

export interface CommandCleanupSchedulerDeps {
  channel: RemoteChannel;
  signal: AbortSignal;
  /**
   * Live read of `remote.delete_command_messages_after`, so a config reload
   * changes the delay for subsequently received commands without a window
   * reload. `0` (or absent) disables cleanup.
   */
  delaySeconds: () => number;
  /**
   * Live read of `remote.delete_command_replies_after`: how long Forge's own
   * reply to a command stays before it is deleted. `0` (or absent) disables.
   */
  replyDelaySeconds?: () => number;
  /** Stable across reloads; reports a failed delete without affecting the command. */
  onError?: ((message: string) => void) | undefined;
}

/**
 * Schedules the best-effort deletion of a processed owner command message — and
 * of Forge's reply to it — from Telegram after configurable delays.
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
    const key = remoteDedupKey(event.channel, event.chatId, event.providerMessageId);
    this.arm(key, event.chatId, event.providerMessageId, this.deps.delaySeconds());
  }

  /**
   * The channel to hand a command handler: identical to `channel`, except that
   * every plain `send`/`sendHtml` reply is scheduled for deletion after
   * `replyDelaySeconds`. Approval prompts (`correlationId`), progress bubbles
   * and paginated selections go through other methods and are never deleted —
   * a deleted button message would strand the action it carries. Replies to
   * `KEEP_REPLIES_OF` commands are left alone.
   */
  trackReplies(channel: RemoteChannel, commandText: string): RemoteChannel {
    const command = commandText.trim().split(/\s+/)[0] ?? '';
    if (KEEP_REPLIES_OF.has(command)) return channel;
    const armReplies = (chatId: string, ids: string[] | void): void => {
      const delaySeconds = this.deps.replyDelaySeconds?.() ?? 0;
      for (const id of ids ?? []) {
        this.arm(remoteDedupKey(channel.name, chatId, `reply:${id}`), chatId, id, delaySeconds);
      }
    };
    return new Proxy(channel, {
      get: (target, property) => {
        if (property === 'send') {
          return async (
            chatId: string,
            text: string,
            options?: { correlationId?: string; signal?: AbortSignal },
          ) => {
            const ids = await target.send(chatId, text, options);
            if (!options?.correlationId) armReplies(chatId, ids);
            return ids;
          };
        }
        if (property === 'sendHtml' && target.sendHtml) {
          return async (chatId: string, html: string, options?: { signal?: AbortSignal }) => {
            const ids = await target.sendHtml!(chatId, html, options);
            armReplies(chatId, ids);
            return ids;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private arm(key: string, chatId: string, messageId: string, delaySeconds: number): void {
    if (delaySeconds <= 0) return;
    if (!this.deps.channel.deleteMessage) return;
    if (this.armed.has(key)) return;
    this.armed.add(key);
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      if (this.deps.signal.aborted) return;
      void (async () => {
        let message: string;
        try {
          await this.deps.channel.deleteMessage!(chatId, messageId, {
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
