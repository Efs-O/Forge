import { z } from 'zod';
import { MAX_TELEGRAM_UPDATE_RETRIES, TelegramAlbumCoordinator } from './TelegramAlbumBuffer';
import { TelegramUpdateSchema, telegramUpdateToEvent } from './TelegramInboundMapping';
import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';

type TelegramCall = (
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;
type TextOrVoiceEvent = Extract<RemoteInboundEvent, { kind: 'text' | 'voice' }>;

export interface TelegramPollingDependencies {
  call: TelegramCall;
  getCursor: (key: string) => string | undefined;
  setCursor: (key: string, value: string) => Promise<void>;
  getHandler: () => ((event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>) | undefined;
  acknowledge: (
    event: TextOrVoiceEvent,
    disposition: RemoteInboundDisposition,
    signal: AbortSignal,
  ) => Promise<void>;
  albumCoordinator: TelegramAlbumCoordinator;
  onError?: ((message: string) => void) | undefined;
}

export const TELEGRAM_CURSOR_KEY = 'telegram:update-offset';

/** Polls Telegram while preserving disposition-before-cursor ordering. */
export async function pollTelegramUpdates(
  signal: AbortSignal,
  dependencies: TelegramPollingDependencies,
): Promise<void> {
  let offset = Number(dependencies.getCursor(TELEGRAM_CURSOR_KEY) ?? '0');
  let consecutiveFailures = 0;
  let retryingUpdateId: number | undefined;
  let retryAttempts = 0;
  if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
  while (!signal.aborted) {
    let updates: z.infer<typeof TelegramUpdateSchema>[];
    try {
      const result = await dependencies.call(
        'getUpdates',
        {
          offset,
          // Give a photo group a short chance to deliver its next update.
          // Telegram may split one album across long-poll responses.
          timeout: dependencies.albumCoordinator.hasPending ? 1 : 25,
          allowed_updates: ['message', 'callback_query'],
        },
        signal,
      );
      updates = z.array(TelegramUpdateSchema).parse(result);
      consecutiveFailures = 0;
    } catch (err) {
      if (signal.aborted) return;
      consecutiveFailures += 1;
      if (consecutiveFailures === 3) {
        dependencies.onError?.(
          `Forge Telegram polling is retrying: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const delay = Math.min(1_000 * 2 ** Math.min(consecutiveFailures - 1, 5), 30_000);
      await abortableDelay(delay, signal);
      continue;
    }
    if (updates.length === 0 && dependencies.albumCoordinator.hasPending) {
      await dependencies.albumCoordinator.flush(signal);
    }
    for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
      if (signal.aborted) return;
      if (await dependencies.albumCoordinator.accept(update, signal)) {
        offset = update.update_id + 1;
        continue;
      }
      // A non-album update ends any album in flight before it is handled.
      if (dependencies.albumCoordinator.hasPending) {
        await dependencies.albumCoordinator.flush(signal);
      }
      const event = telegramUpdateToEvent(update);
      let disposition: RemoteInboundDisposition = event
        ? { kind: 'retry', reason: 'remote event handler is unavailable' }
        : { kind: 'handled' };
      const handler = dependencies.getHandler();
      if (event && handler) {
        try {
          disposition = await handler(event);
        } catch (err) {
          disposition = {
            kind: 'retry',
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }
      if (disposition.kind === 'retry') {
        if (update.update_id === retryingUpdateId) retryAttempts += 1;
        else {
          retryingUpdateId = update.update_id;
          retryAttempts = 1;
        }
        if (retryAttempts >= MAX_TELEGRAM_UPDATE_RETRIES) {
          disposition = { kind: 'rejected', reason: disposition.reason };
          retryingUpdateId = undefined;
          retryAttempts = 0;
        }
      } else if (update.update_id === retryingUpdateId) {
        retryingUpdateId = undefined;
        retryAttempts = 0;
      }
      if (event && (event.kind === 'text' || event.kind === 'voice')) {
        await dependencies.acknowledge(event, disposition, signal);
      }
      if (update.callback_query) {
        await dependencies
          .call(
            'answerCallbackQuery',
            {
              callback_query_id: update.callback_query.id,
              text: disposition.kind === 'rejected' ? disposition.reason.slice(0, 200) : 'Received',
            },
            signal,
          )
          .catch(() => undefined);
      }
      if (disposition.kind === 'retry') break;
      offset = update.update_id + 1;
      await dependencies.setCursor(TELEGRAM_CURSOR_KEY, String(offset));
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
