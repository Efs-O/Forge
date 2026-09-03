import { z } from 'zod';
import * as path from 'path';
import type { RemoteInboundEvent } from './types';
import { parseTelegramSelectionCallback } from './TelegramSelectionPagination';

/**
 * Bot API update -> `RemoteInboundEvent`, and the media-type guesses that go
 * with it.
 *
 * Split out of `TelegramChannel` because it shares nothing with it: the mapping
 * touches no client state, no token and no socket, and it is where every
 * inbound-shape bug has actually lived -- a voice note silently dropped, a
 * binary attachment decoded as utf8. Testing it needs a JSON object, not a
 * polling loop.
 */

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      date: z.number().int(),
      text: z.string().optional(),
      caption: z.string().optional(),
      document: z
        .object({
          file_id: z.string(),
          file_name: z.string().optional(),
          mime_type: z.string().optional(),
          file_size: z.number().int().nonnegative().optional(),
        })
        .optional(),
      photo: z
        .array(
          z.object({ file_id: z.string(), file_size: z.number().int().nonnegative().optional() }),
        )
        .optional(),
      /**
       * `duration` is load-bearing, not informational: with `date` it defines
       * the recording window that correlates a spoken command to one pending
       * approval (docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §22A R1-revised).
       */
      voice: z
        .object({
          file_id: z.string(),
          duration: z.number().int().nonnegative(),
          mime_type: z.string().optional(),
          file_size: z.number().int().nonnegative().optional(),
        })
        .optional(),
      /** An explicit reply always wins over the recording-window heuristic. */
      reply_to_message: z.object({ message_id: z.number().int() }).optional(),
      chat: z.object({ id: z.union([z.number(), z.string()]), type: z.string() }),
      from: z.object({ id: z.union([z.number(), z.string()]) }).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      from: z.object({ id: z.union([z.number(), z.string()]) }),
      message: z
        .object({
          message_id: z.number().int(),
          chat: z.object({ id: z.union([z.number(), z.string()]), type: z.string() }),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Types whose bytes really are text. Everything else is base64: see the note in
 * `downloadAttachment`.
 */
export function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'application/xml' ||
    mediaType.endsWith('+json') ||
    mediaType.endsWith('+xml')
  );
}

/**
 * Telegram's `getFile` returns a path but no content type. The extension is all
 * there is, and only the voice formats need to be right -- ffmpeg sniffs the
 * container anyway, so this feeds the audit row rather than the decoder.
 */
export function mediaTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    '.oga': 'audio/ogg',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
  };
  return known[extension] ?? 'application/octet-stream';
}

function telegramChatType(value: string): RemoteInboundEvent['chatType'] {
  if (value === 'private') return 'private';
  return value === 'channel' ? 'channel' : 'group';
}

export function telegramUpdateToEvent(
  update: z.infer<typeof TelegramUpdateSchema>,
): RemoteInboundEvent | undefined {
  const message = update.message;
  // Before the text branch: a voice note carries no `text`, so it would
  // otherwise fall through and be dropped while the cursor still advanced.
  if (message && message.from && message.voice) {
    return {
      channel: 'telegram',
      kind: 'voice',
      providerMessageId: String(message.message_id),
      senderId: String(message.from.id),
      chatId: String(message.chat.id),
      chatType: telegramChatType(message.chat.type),
      receivedAt: message.date * 1000,
      providerFileId: message.voice.file_id,
      mediaType: message.voice.mime_type ?? 'audio/ogg',
      durationMs: message.voice.duration * 1000,
      ...(message.reply_to_message
        ? { replyToMessageId: String(message.reply_to_message.message_id) }
        : {}),
    };
  }
  if (
    message &&
    message.from &&
    (message.text !== undefined || message.document || message.photo)
  ) {
    const document = message.document;
    const photo = message.photo?.at(-1);
    const attachment = document
      ? {
          name: document.file_name ?? 'telegram-document',
          mediaType: document.mime_type ?? 'application/octet-stream',
          providerFileId: document.file_id,
        }
      : photo
        ? { name: 'telegram-photo.jpg', mediaType: 'image/jpeg', providerFileId: photo.file_id }
        : undefined;
    return {
      channel: 'telegram',
      kind: 'text',
      providerMessageId: String(message.message_id),
      senderId: String(message.from.id),
      chatId: String(message.chat.id),
      chatType: telegramChatType(message.chat.type),
      receivedAt: message.date * 1000,
      text: message.text ?? message.caption ?? '',
      ...(attachment ? { attachments: [attachment] } : {}),
    };
  }
  const callback = update.callback_query;
  if (!callback || !callback.message || !callback.data) return undefined;
  const selection = parseTelegramSelectionCallback(callback.data);
  if (selection) {
    return {
      channel: 'telegram',
      kind: 'selection',
      providerMessageId: callback.id,
      senderId: String(callback.from.id),
      chatId: String(callback.message.chat.id),
      chatType: telegramChatType(callback.message.chat.type),
      receivedAt: Date.now(),
      selectionKind: selection.kind,
      selectionToken: selection.token,
      action: selection.action,
      ...(selection.page === undefined ? {} : { page: selection.page }),
      messageId: String(callback.message.message_id),
    };
  }
  const match = /^([ad]):(.+)$/.exec(callback.data);
  if (!match) return undefined;
  return {
    channel: 'telegram',
    kind: 'action',
    providerMessageId: callback.id,
    senderId: String(callback.from.id),
    chatId: String(callback.message.chat.id),
    chatType: telegramChatType(callback.message.chat.type),
    receivedAt: Date.now(),
    action: match[1] === 'a' ? 'approve' : 'deny',
    correlationId: match[2]!,
  };
}
