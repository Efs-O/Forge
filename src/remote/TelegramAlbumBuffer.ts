import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { z } from 'zod';
import {
  albumPhotoFromUpdate,
  telegramChatType,
  TelegramUpdateSchema,
} from './TelegramInboundMapping';

export const MAX_TELEGRAM_IMAGES_PER_MESSAGE = 3;
export const MAX_TELEGRAM_UPDATE_RETRIES = 3;

export interface TelegramAlbumPhoto {
  name: string;
  mediaType: string;
  providerFileId: string;
}

export interface TelegramAlbumInput {
  updateId: number;
  mediaGroupId: string;
  photo: TelegramAlbumPhoto;
  firstText: string;
  firstMessageId: number;
  chatId: string;
  senderId: string;
  chatType: RemoteInboundEvent['chatType'];
  receivedAt: number;
}

type TelegramTextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

export interface PendingTelegramAlbum {
  mediaGroupId: string;
  event: TelegramTextEvent;
  lastUpdateId: number;
  overflow: boolean;
}

/** Buffers adjacent Telegram album photos without owning polling or I/O. */
export class TelegramAlbumBuffer {
  private pending: PendingTelegramAlbum | undefined;

  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  get mediaGroupId(): string | undefined {
    return this.pending?.mediaGroupId;
  }

  add(input: TelegramAlbumInput): void {
    const current = this.pending;
    if (!current || current.mediaGroupId !== input.mediaGroupId) {
      this.pending = {
        mediaGroupId: input.mediaGroupId,
        event: {
          channel: 'telegram',
          kind: 'text',
          providerMessageId: String(input.firstMessageId),
          senderId: input.senderId,
          chatId: input.chatId,
          chatType: input.chatType,
          receivedAt: input.receivedAt,
          text: input.firstText,
          attachments: [input.photo],
        },
        lastUpdateId: input.updateId,
        overflow: false,
      };
      return;
    }

    current.lastUpdateId = input.updateId;
    if (current.event.attachments!.length >= MAX_TELEGRAM_IMAGES_PER_MESSAGE) {
      current.overflow = true;
      return;
    }
    current.event.attachments!.push(input.photo);
  }

  take(): PendingTelegramAlbum | undefined {
    const current = this.pending;
    this.pending = undefined;
    return current;
  }
}

export interface TelegramAlbumFlushDependencies {
  signal: AbortSignal;
  handle: (event: TelegramTextEvent) => Promise<RemoteInboundDisposition>;
  acknowledge: (
    event: TelegramTextEvent,
    disposition: RemoteInboundDisposition,
    signal: AbortSignal,
  ) => Promise<void>;
  commitCursor: (offset: number) => Promise<void>;
  onOverflow: (event: TelegramTextEvent, signal: AbortSignal) => Promise<void>;
  /**
   * Reports a cursor-commit failure. A throw here must not escape the flush:
   * the album has already been handled and acknowledged, so the only remaining
   * effect of a persistence failure is that the durable cursor stays before the
   * album and Telegram redelivers it on restart — the safe outcome. Letting the
   * error propagate instead would take the whole poll loop down with it.
   */
  onError?: ((message: string) => void) | undefined;
}

/** Handles one buffered album with the same retry-before-cursor contract as a normal update. */
export async function flushTelegramAlbum(
  album: PendingTelegramAlbum,
  dependencies: TelegramAlbumFlushDependencies,
): Promise<void> {
  let disposition: RemoteInboundDisposition = {
    kind: 'retry',
    reason: 'remote event handler is unavailable',
  };
  for (let attempt = 0; attempt < MAX_TELEGRAM_UPDATE_RETRIES; attempt++) {
    try {
      disposition = await dependencies.handle(album.event);
    } catch (err) {
      disposition = { kind: 'retry', reason: err instanceof Error ? err.message : String(err) };
    }
    if (disposition.kind !== 'retry') break;
  }
  if (disposition.kind === 'retry') {
    disposition = { kind: 'rejected', reason: disposition.reason };
  }

  await dependencies.acknowledge(album.event, disposition, dependencies.signal);
  try {
    await dependencies.commitCursor(album.lastUpdateId + 1);
  } catch (err) {
    dependencies.onError?.(
      `Forge Telegram album cursor commit failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (album.overflow) await dependencies.onOverflow(album.event, dependencies.signal);
}

export interface TelegramAlbumCoordinatorDependencies {
  handle: TelegramAlbumFlushDependencies['handle'];
  acknowledge: TelegramAlbumFlushDependencies['acknowledge'];
  commitCursor: TelegramAlbumFlushDependencies['commitCursor'];
  onOverflow: TelegramAlbumFlushDependencies['onOverflow'];
  onError?: TelegramAlbumFlushDependencies['onError'];
}

/** Couples update mapping, buffering, and dispatch so the channel stays focused on polling. */
export class TelegramAlbumCoordinator {
  private readonly buffer = new TelegramAlbumBuffer();

  constructor(private readonly dependencies: TelegramAlbumCoordinatorDependencies) {}

  get hasPending(): boolean {
    return this.buffer.hasPending;
  }

  get mediaGroupId(): string | undefined {
    return this.buffer.mediaGroupId;
  }

  async accept(
    update: z.infer<typeof TelegramUpdateSchema>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const photo = albumPhotoFromUpdate(update);
    if (!photo) return false;
    const message = update.message!;
    const groupId = message.media_group_id!;
    if (this.mediaGroupId !== undefined && this.mediaGroupId !== groupId) {
      await this.flush(signal);
    }
    this.buffer.add({
      updateId: update.update_id,
      mediaGroupId: groupId,
      photo,
      firstText: message.text ?? message.caption ?? '',
      firstMessageId: message.message_id,
      chatId: String(message.chat.id),
      senderId: String(message.from!.id),
      chatType: telegramChatType(message.chat.type),
      receivedAt: message.date * 1000,
    });
    return true;
  }

  async flush(signal: AbortSignal): Promise<void> {
    const album = this.buffer.take();
    if (!album) return;
    await flushTelegramAlbum(album, { signal, ...this.dependencies });
  }
}
