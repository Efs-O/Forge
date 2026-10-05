import { describe, expect, it } from 'vitest';
import {
  albumPhotoFromUpdate,
  TelegramUpdateSchema,
  telegramUpdateToEvent,
} from '../../src/remote/TelegramInboundMapping';

function message(overrides: Record<string, unknown>): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: 99, type: 'private' },
      from: { id: 123 },
      ...overrides,
    },
  };
}

/**
 * Phase 3: an unhandled media type must produce an event, not `undefined`.
 *
 * `undefined` is what the polling loop reads as "nothing to do", so the cursor
 * advanced and the sender watched their video vanish — the same silent-drop
 * shape the voice note had before it was mapped.
 */
describe('Telegram inbound mapping — unsupported media', () => {
  it('maps a video message to an unsupported_media event', () => {
    expect(
      telegramUpdateToEvent(
        TelegramUpdateSchema.parse(message({ video: { file_id: 'video-1' } })),
      ),
    ).toMatchObject({
      channel: 'telegram',
      kind: 'unsupported_media',
      mediaType: 'video',
      providerMessageId: '10',
      senderId: '123',
      chatId: '99',
      chatType: 'private',
      receivedAt: 1_700_000_000_000,
    });
  });

  it('maps a live photo to unsupported_media with mediaType live_photo', () => {
    expect(
      telegramUpdateToEvent(
        TelegramUpdateSchema.parse(message({ live_photo: { file_id: 'live-1' } })),
      ),
    ).toMatchObject({ kind: 'unsupported_media', mediaType: 'live_photo' });
  });

  it('names every unsupported type the transport can deliver', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ video_note: { file_id: 'v' } }, 'video_note'],
      [{ animation: { file_id: 'a' } }, 'animation'],
      [{ sticker: { file_id: 's' } }, 'sticker'],
      [{ audio: { file_id: 'au' } }, 'audio'],
      [{ location: { latitude: 1, longitude: 2 } }, 'location'],
      [{ contact: { phone_number: '1', first_name: 'N' } }, 'contact'],
      [{ poll: { question: 'why' } }, 'poll'],
    ];
    for (const [field, mediaType] of cases) {
      expect(telegramUpdateToEvent(TelegramUpdateSchema.parse(message(field)))).toMatchObject({
        kind: 'unsupported_media',
        mediaType,
      });
    }
  });

  /**
   * The ordering that matters: a captioned video is media, not a text prompt.
   * Accepted as text, Forge would answer a question about a video it never saw.
   */
  it('rejects a captioned video as media rather than accepting it as text', () => {
    expect(
      telegramUpdateToEvent(
        TelegramUpdateSchema.parse(message({ video: { file_id: 'video-2' }, caption: 'look' })),
      ),
    ).toMatchObject({ kind: 'unsupported_media', mediaType: 'video' });
  });

  it('carries the same identity fields a text event carries', () => {
    const event = telegramUpdateToEvent(
      TelegramUpdateSchema.parse(
        message({ sticker: { file_id: 's' }, chat: { id: 7, type: 'group', title: 'Team' } }),
      ),
    );
    expect(event).toMatchObject({
      chatId: '7',
      chatType: 'group',
      chatTitle: 'Team',
      senderId: '123',
      providerMessageId: '10',
    });
  });

  /**
   * A service message sets none of the named media fields, so it stays
   * unmapped instead of drawing a "not supported yet" notice from nobody.
   */
  it('does not mislabel a service message as unsupported media', () => {
    const service = {
      update_id: 2,
      message: {
        message_id: 11,
        date: 1_700_000_000,
        chat: { id: 99, type: 'group' },
        from: { id: 123 },
        new_chat_members: [{ id: 456 }],
      },
    };
    expect(telegramUpdateToEvent(TelegramUpdateSchema.parse(service))).toBeUndefined();
  });

  it('leaves an ordinary empty message unmapped', () => {
    expect(telegramUpdateToEvent(TelegramUpdateSchema.parse(message({})))).toBeUndefined();
  });

  /**
   * A channel post has no `from`. It must stay silent: there is no user to
   * answer, and a rejection would be aimed at an identity that does not exist.
   */
  it('does not reject unhandled media from a message with no sender', () => {
    const post = {
      update_id: 3,
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: 500, type: 'channel' },
        video: { file_id: 'video-3' },
      },
    };
    expect(telegramUpdateToEvent(TelegramUpdateSchema.parse(post))).toBeUndefined();
  });

  /** The handled set must keep flowing untouched — Phase 3 adds no regressions. */
  it('leaves text, photo, document, and voice handling unchanged', () => {
    expect(telegramUpdateToEvent(TelegramUpdateSchema.parse(message({ text: 'hi' })))).toMatchObject(
      { kind: 'text', text: 'hi' },
    );
    expect(
      telegramUpdateToEvent(
        TelegramUpdateSchema.parse(message({ photo: [{ file_id: 'p', file_size: 1 }] })),
      ),
    ).toMatchObject({ kind: 'text', attachments: [{ providerFileId: 'p' }] });
    expect(
      telegramUpdateToEvent(
        TelegramUpdateSchema.parse(message({ document: { file_id: 'd', mime_type: 'text/plain' } })),
      ),
    ).toMatchObject({ kind: 'text', attachments: [{ providerFileId: 'd' }] });
    expect(
      telegramUpdateToEvent(
        TelegramUpdateSchema.parse(
          message({ voice: { file_id: 'v', duration: 2, mime_type: 'audio/ogg' } }),
        ),
      ),
    ).toMatchObject({ kind: 'voice', durationMs: 2000 });
  });

  /** A photo that is also something else is judged by the unhandled field first. */
  it('prefers the unhandled type when a message carries both a live photo and a still', () => {
    expect(
      telegramUpdateToEvent(
        TelegramUpdateSchema.parse(
          message({
            live_photo: { file_id: 'live-2' },
            photo: [{ file_id: 'still-2', file_size: 1 }],
          }),
        ),
      ),
    ).toMatchObject({ kind: 'unsupported_media', mediaType: 'live_photo' });
  });

  /**
   * The same rule on the album helper, which TelegramPolling consults BEFORE
   * this mapper. Telegram sets `photo` beside `live_photo` for backward
   * compatibility, so an album-shaped live photo is exactly the update that must
   * be declined here and handed back to `telegramUpdateToEvent`.
   */
  it('declines an album live_photo instead of buffering its still frame', () => {
    const albumLivePhoto = message({
      live_photo: { file_id: 'live-3' },
      photo: [{ file_id: 'still-3', file_size: 1 }],
      media_group_id: 'g1',
    });
    const parsed = TelegramUpdateSchema.parse(albumLivePhoto);
    expect(albumPhotoFromUpdate(parsed)).toBeUndefined();
    expect(telegramUpdateToEvent(parsed)).toMatchObject({
      kind: 'unsupported_media',
      mediaType: 'live_photo',
    });
  });

  /** An ordinary album photo still buffers — the decline is not a blanket veto. */
  it('buffers an ordinary album photo', () => {
    const parsed = TelegramUpdateSchema.parse(
      message({ photo: [{ file_id: 'p1', file_size: 1 }], media_group_id: 'g1' }),
    );
    expect(albumPhotoFromUpdate(parsed)).toMatchObject({ providerFileId: 'p1' });
  });
});

/**
 * Phase 2: the native Stop button on a rich-draft preview.
 *
 * `stopped_message_generation` carries a chat and a draft id and nothing else —
 * no `from`, no `message_id`. So the mapping has to invent the least it can:
 * derive the private-chat identity from the chat id, and use the `update_id` as
 * the only stable id available for deduplication.
 */
describe('Telegram inbound mapping — stopped message generation', () => {
  function stoppedUpdate(overrides: Record<string, unknown> = {}): unknown {
    return {
      update_id: 77,
      stopped_message_generation: {
        chat: { id: 99, type: 'private' },
        draft_id: 42,
        ...overrides,
      },
    };
  }

  it('maps a stopped update to its own event kind, never a synthesized /stop', () => {
    const parsed = TelegramUpdateSchema.parse(stoppedUpdate());
    expect(telegramUpdateToEvent(parsed)).toEqual({
      channel: 'telegram',
      kind: 'generation_stopped',
      // The update_id is the only stable id this update has, and reusing it is
      // what makes a redelivered Stop deduplicate instead of cancelling twice.
      providerMessageId: '77',
      senderId: '99',
      chatId: '99',
      chatType: 'private',
      receivedAt: expect.any(Number),
      draftId: 42,
    });
  });

  it('derives the sender from the chat id because Telegram sends no `from`', () => {
    const event = telegramUpdateToEvent(TelegramUpdateSchema.parse(stoppedUpdate()));
    expect(event).toMatchObject({ senderId: '99', chatId: '99' });
    expect(event && 'text' in event).toBe(false);
  });

  it('carries a group chat type through so the group gate can refuse it', () => {
    const event = telegramUpdateToEvent(
      TelegramUpdateSchema.parse(
        stoppedUpdate({ chat: { id: -100, type: 'group', title: 'Team' } }),
      ),
    );
    expect(event).toMatchObject({ chatId: '-100', chatType: 'group', chatTitle: 'Team' });
  });

  it('accepts a draft id only as an integer', () => {
    expect(() =>
      TelegramUpdateSchema.parse(stoppedUpdate({ draft_id: '42' })),
    ).toThrowError();
  });

  it('maps a stopped update before any message branch, since it has no message', () => {
    const parsed = TelegramUpdateSchema.parse({
      update_id: 78,
      stopped_message_generation: { chat: { id: 5, type: 'private' }, draft_id: 1 },
    });
    expect(parsed.message).toBeUndefined();
    expect(telegramUpdateToEvent(parsed)).toMatchObject({ kind: 'generation_stopped' });
  });
});
