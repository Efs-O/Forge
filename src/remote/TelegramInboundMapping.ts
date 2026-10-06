import { z } from 'zod';
import * as path from 'path';
import type { RemoteInboundEvent } from './types';
import { parseTelegramSelectionCallback } from './TelegramSelectionPagination';
import { parseTelegramQuestionCallback } from './TelegramQuestionButtons';
import { parseTelegramHelpCallback } from './TelegramHelpButtons';
import { isTelegramStopCallback } from './TelegramStopButton';

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
       * Set on every photo of a Telegram photo *album*. An album is delivered
       * as separate `photo` updates that all share one `media_group_id`; the
       * channel groups them into one multi-image prompt (see
       * `albumPhotoFromUpdate`). A single photo has no group id.
       */
      media_group_id: z.string().optional(),
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
      /**
       * Media Forge does not handle, named explicitly so their presence is
       * detectable. Zod strips unknown keys, so a field absent from this schema
       * is invisible — which is exactly how every one of these used to be
       * dropped silently while the cursor still advanced. `contact` is the
       * shared-contact attachment, not the sender's identity.
       */
      live_photo: z.object({ file_id: z.string() }).optional(),
      video: z.object({ file_id: z.string() }).optional(),
      video_note: z.object({ file_id: z.string() }).optional(),
      animation: z.object({ file_id: z.string() }).optional(),
      sticker: z.object({ file_id: z.string() }).optional(),
      audio: z.object({ file_id: z.string() }).optional(),
      location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
      contact: z
        .object({
          phone_number: z.string(),
          first_name: z.string(),
          last_name: z.string().optional(),
          user_id: z.number().int().optional(),
        })
        .optional(),
      poll: z
        .object({ poll_id: z.string().optional(), question: z.string().optional() })
        .optional(),
      chat: z.object({
        id: z.union([z.number(), z.string()]),
        type: z.string(),
        title: z.string().optional(),
      }),
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
          chat: z.object({
            id: z.union([z.number(), z.string()]),
            type: z.string(),
            title: z.string().optional(),
          }),
        })
        .optional(),
    })
    .optional(),
  /**
   * The user pressed Stop on a rich-draft preview. `chat` and `draft_id` are
   * all there is — there is no `from` and no message id, which is why this
   * becomes its own event kind instead of a synthesized `/stop`.
   */
  stopped_message_generation: z
    .object({
      chat: z.object({
        id: z.union([z.number(), z.string()]),
        type: z.string(),
        title: z.string().optional(),
      }),
      draft_id: z.number().int(),
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

export function telegramChatType(value: string): RemoteInboundEvent['chatType'] {
  if (value === 'private') return 'private';
  return value === 'channel' ? 'channel' : 'group';
}

/**
 * The photo of a Telegram album (photo group) update, or `undefined` if this
 * update is not one. An album is a burst of separate `photo` updates sharing a
 * `media_group_id`; the channel buffers them into one multi-image prompt rather
 * than letting each become its own queued request. A single photo with no group
 * id is NOT an album and keeps flowing through `telegramUpdateToEvent`
 * untouched, so this helper never changes single-photo behaviour.
 *
 * A message that also carries unsupported media is declined, even when it has a
 * `media_group_id`. `TelegramPolling` asks the album coordinator before it asks
 * the mapper, so anything accepted here never reaches the `unsupported_media`
 * branch — and Telegram's own `live_photo` sets `photo` alongside it for
 * backward compatibility, which would otherwise let a live photo in an album be
 * admitted as an ordinary still image while a lone live photo gets the notice.
 * Declining hands the update to `telegramUpdateToEvent`, which rejects it.
 */
export function albumPhotoFromUpdate(
  update: z.infer<typeof TelegramUpdateSchema>,
): { name: string; mediaType: string; providerFileId: string } | undefined {
  const message = update.message;
  const photo = message?.photo?.at(-1);
  if (!message?.from || !photo || !message.media_group_id) return undefined;
  if (unsupportedUserMedia(message)) return undefined;
  return { name: 'telegram-photo.jpg', mediaType: 'image/jpeg', providerFileId: photo.file_id };
}

/**
 * The user media Forge cannot handle, in the order they are checked. Ordered
 * and closed rather than a free string: the name is echoed back to the sender,
 * and a bounded set is what keeps the notice honest about what the transport
 * can actually receive.
 */
const UNSUPPORTED_USER_MEDIA = [
  ['live_photo', 'live_photo'],
  ['video', 'video'],
  ['video_note', 'video_note'],
  ['animation', 'animation'],
  ['sticker', 'sticker'],
  ['audio', 'audio'],
  ['location', 'location'],
  ['contact', 'contact'],
  ['poll', 'poll'],
] as const satisfies ReadonlyArray<readonly [string, RemoteUnsupportedMediaEvent['mediaType']]>;

export type RemoteUnsupportedMediaEvent = Extract<
  RemoteInboundEvent,
  { kind: 'unsupported_media' }
>;

/**
 * Which unhandled media a message carries, or `undefined` if it carries none.
 *
 * Deliberately keyed off the named fields only: a service message
 * (`new_chat_members`, `pinned_message`, a giveaway) sets none of them, so it
 * cannot be mislabeled as media the user should be told about, and an ordinary
 * empty message is not media either.
 *
 * Also consulted by `albumPhotoFromUpdate`, because the album path is asked
 * before the mapper and `live_photo` arrives with `photo` set beside it.
 */
function unsupportedUserMedia(
  message: NonNullable<z.infer<typeof TelegramUpdateSchema>['message']>,
): RemoteUnsupportedMediaEvent['mediaType'] | undefined {
  for (const [field, mediaType] of UNSUPPORTED_USER_MEDIA) {
    if (message[field as keyof typeof message] !== undefined) return mediaType;
  }
  return undefined;
}

export function telegramUpdateToEvent(
  update: z.infer<typeof TelegramUpdateSchema>,
): RemoteInboundEvent | undefined {
  /**
   * Checked first, and deliberately before every `message` branch: this update
   * has no message at all, so nothing else here could match it. The identity it
   * carries is the Telegram `update_id` — the only stable id this update has —
   * which is what makes a redelivered Stop deduplicate instead of cancelling
   * twice. `senderId` is derived from the chat id because Telegram sends no
   * `from`: in a private chat the chat and the user are the same principal, and
   * the owner gate still has to pass on that derived id.
   */
  const stopped = update.stopped_message_generation;
  if (stopped) {
    return {
      channel: 'telegram',
      kind: 'generation_stopped',
      providerMessageId: String(update.update_id),
      senderId: String(stopped.chat.id),
      chatId: String(stopped.chat.id),
      chatType: telegramChatType(stopped.chat.type),
      receivedAt: Date.now(),
      ...(stopped.chat.title ? { chatTitle: stopped.chat.title } : {}),
      draftId: stopped.draft_id,
    };
  }
  const message = update.message;
  /**
   * Unsupported media is checked before the text/caption branch on purpose.
   * A video with a caption would otherwise satisfy the text condition and be
   * admitted as a text-only prompt, silently discarding the media the user
   * actually sent; the sender would then watch Forge answer a question about a
   * video it never saw. `from` is required so a channel post or service message
   * cannot produce a rejection aimed at a user who is not there.
   */
  if (message && message.from) {
    const mediaType = unsupportedUserMedia(message);
    if (mediaType) {
      return {
        channel: 'telegram',
        kind: 'unsupported_media',
        mediaType,
        providerMessageId: String(message.message_id),
        senderId: String(message.from.id),
        chatId: String(message.chat.id),
        chatType: telegramChatType(message.chat.type),
        receivedAt: message.date * 1000,
        ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
      };
    }
  }
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
      ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
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
      ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
      text: message.text ?? message.caption ?? '',
      ...(attachment ? { attachments: [attachment] } : {}),
      ...(message.reply_to_message
        ? { replyToMessageId: String(message.reply_to_message.message_id) }
        : {}),
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
      ...(selection.choice === undefined ? {} : { choice: selection.choice }),
      messageId: String(callback.message.message_id),
    };
  }
  const question = parseTelegramQuestionCallback(callback.data);
  if (question) {
    return {
      channel: 'telegram',
      kind: 'question_action',
      providerMessageId: callback.id,
      senderId: String(callback.from.id),
      chatId: String(callback.message.chat.id),
      chatType: telegramChatType(callback.message.chat.type),
      receivedAt: Date.now(),
      questionId: question.questionId,
      action: question.action,
      ...(question.choice === undefined ? {} : { choice: question.choice }),
      messageId: String(callback.message.message_id),
    };
  }
  const help = parseTelegramHelpCallback(callback.data);
  if (help) {
    return {
      channel: 'telegram',
      kind: 'help_action',
      providerMessageId: callback.id,
      senderId: String(callback.from.id),
      chatId: String(callback.message.chat.id),
      chatType: telegramChatType(callback.message.chat.type),
      receivedAt: Date.now(),
      action: 'close',
      helpToken: help.token,
      messageId: String(callback.message.message_id),
    };
  }
  if (isTelegramStopCallback(callback.data)) {
    return {
      channel: 'telegram',
      kind: 'stop_action',
      providerMessageId: callback.id,
      senderId: String(callback.from.id),
      chatId: String(callback.message.chat.id),
      chatType: telegramChatType(callback.message.chat.type),
      receivedAt: Date.now(),
      messageId: String(callback.message.message_id),
    };
  }
  const contact = /^c:([A-Za-z0-9_-]{16,48}):([sc])$/.exec(callback.data);
  if (contact) {
    return {
      channel: 'telegram',
      kind: 'contact_action',
      providerMessageId: callback.id,
      senderId: String(callback.from.id),
      chatId: String(callback.message.chat.id),
      chatType: telegramChatType(callback.message.chat.type),
      receivedAt: Date.now(),
      action: contact[2] === 's' ? 'send' : 'cancel',
      correlationId: contact[1]!,
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
