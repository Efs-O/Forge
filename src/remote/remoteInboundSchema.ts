import { z } from 'zod';

/**
 * The inbound event contract, in its own module.
 *
 * `types.ts` is the remote type barrel and had reached the lint line limit
 * before the resolved-keyboard affordance could be added to `RemoteChannel`;
 * this block is the one self-contained piece of it (zod only, no other remote
 * imports), so extracting it keeps `types.ts` the single import site for
 * callers while leaving room for the event variants the phases add.
 */

const InboundBaseSchema = z.object({
  channel: z.enum(['fake', 'telegram', 'whatsapp']),
  providerMessageId: z.string().min(1).max(256),
  senderId: z.string().min(1).max(256),
  chatId: z.string().min(1).max(256),
  chatType: z.enum(['private', 'group', 'channel']),
  receivedAt: z.number().int().nonnegative(),
  chatTitle: z.string().trim().max(256).optional(),
});

export const RemoteInboundAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(128),
  /** Base64 for binary input, UTF-8 for text. Never persisted in remote state. */
  data: z
    .string()
    .min(1)
    .max(14 * 1024 * 1024)
    .optional(),
  providerFileId: z.string().min(1).max(256).optional(),
});

export type RemoteInboundAttachment = z.infer<typeof RemoteInboundAttachmentSchema>;

export const RemoteInboundEventSchema = z.discriminatedUnion('kind', [
  InboundBaseSchema.extend({
    kind: z.literal('text'),
    text: z.string(),
    attachments: z.array(RemoteInboundAttachmentSchema).max(10).optional(),
    /** Set when the message replies to another; a reply to a session question answers it. */
    replyToMessageId: z.string().min(1).max(256).optional(),
  }),
  /**
   * A voice note. Deliberately NOT a `text` event with an audio attachment:
   * `RemoteInboundAttachment.data` is a string, and putting audio through it
   * would base64-inflate it against a 14 MB cap and then be written back out to
   * a temp file two steps later anyway (§9.2). Only the file id crosses here;
   * the bytes go straight to disk via `downloadAttachmentToFile`.
   */
  InboundBaseSchema.extend({
    kind: z.literal('voice'),
    providerFileId: z.string().min(1).max(256),
    mediaType: z.string().min(1).max(128),
    /**
     * Client-reported clip length. Load-bearing twice over: it rejects an
     * over-long note before a byte is downloaded, and with `receivedAt` it
     * defines the recording window that correlates a spoken command to one
     * pending approval (§22A R1-revised).
     */
    durationMs: z.number().int().nonnegative(),
    /** Set when the note was sent as a reply; wins over the timing heuristic. */
    replyToMessageId: z.string().min(1).max(256).optional(),
  }),
  InboundBaseSchema.extend({
    kind: z.literal('action'),
    action: z.enum(['approve', 'deny']),
    correlationId: z.string().min(1).max(256),
  }),
  /**
   * A media type Forge does not handle — a video, sticker, live photo, poll.
   *
   * Before this, such a message matched no branch of the Telegram mapping, so
   * it produced no event while the polling cursor still advanced: the update
   * was consumed and the sender saw nothing (the same failure shape the voice
   * note had before it was mapped). The type is a closed enum rather than a
   * free string because it is echoed back to the sender in the rejection text,
   * and only names the transport can actually produce belong there.
   */
  InboundBaseSchema.extend({
    kind: z.literal('unsupported_media'),
    mediaType: z.enum([
      'live_photo',
      'video',
      'video_note',
      'animation',
      'sticker',
      'audio',
      'location',
      'contact',
      'poll',
    ]),
  }),
  InboundBaseSchema.extend({
    kind: z.literal('contact_action'),
    action: z.enum(['send', 'cancel']),
    correlationId: z.string().regex(/^[A-Za-z0-9_-]{16,48}$/),
    messageId: z.string().min(1).max(256),
  }),
  InboundBaseSchema.extend({
    kind: z.literal('question_action'),
    action: z.enum(['select', 'other']),
    questionId: z.string().regex(/^[A-Za-z0-9_-]{1,48}$/),
    choice: z.number().int().min(0).max(99).optional(),
    messageId: z.string().min(1).max(256),
  }),
  InboundBaseSchema.extend({
    kind: z.literal('help_action'),
    action: z.literal('close'),
    helpToken: z.literal('x'),
    messageId: z.string().min(1).max(256),
  }),
  InboundBaseSchema.extend({
    kind: z.literal('selection'),
    selectionKind: z.enum(['models', 'conversations', 'workspaces']),
    selectionToken: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
    action: z.enum(['show', 'close', 'select']),
    page: z.number().int().min(0).max(9).optional(),
    choice: z.number().int().min(0).max(99).optional(),
    messageId: z.string().min(1).max(256),
  }),
  /**
   * The ⏹ Stop button under a turn's status bubble. `messageId` is the tapped
   * bubble; the controller cancels only the turn that bubble belongs to.
   */
  InboundBaseSchema.extend({
    kind: z.literal('stop_action'),
    messageId: z.string().min(1).max(256),
  }),
]);

export type RemoteInboundEvent = z.infer<typeof RemoteInboundEventSchema>;
