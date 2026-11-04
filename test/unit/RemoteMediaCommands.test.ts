import { describe, expect, it, vi } from 'vitest';
import { handleRemoteMediaCommand } from '../../src/remote/RemoteMediaCommands';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import type { RemoteInboundEvent } from '../../src/remote/types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

function event(text: string, attachments?: TextEvent['attachments']): TextEvent {
  return {
    channel: 'telegram',
    kind: 'text',
    providerMessageId: 'm-1',
    senderId: 'u-1',
    chatId: 'chat-1',
    chatType: 'private',
    receivedAt: 1,
    text,
    ...(attachments ? { attachments } : {}),
  };
}

function context(
  options: {
    enabled?: boolean;
    queued?: ReturnType<typeof vi.fn>;
    markCommitted?: () => void;
  } = {},
): { context: RemoteCommandContext; channel: FakeRemoteChannel } {
  const channel = new FakeRemoteChannel();
  const queue = options.queued ?? vi.fn(async () => ({ kind: 'accepted' as const }));
  const partial = {
    channel,
    signal: new AbortController().signal,
    mediaCommands: {
      enabled: options.enabled ?? true,
      setupText: 'Media setup: LTX configured; music analyzer missing.',
      queue,
    },
    ...(options.markCommitted ? { markCommitted: options.markCommitted } : {}),
  };
  return { context: partial as unknown as RemoteCommandContext, channel };
}

describe('remote media commands', () => {
  it('reports the shared media setup status', async () => {
    const { context: commandContext, channel } = context();
    expect(await handleRemoteMediaCommand(event('/media'), commandContext, 'd-1')).toEqual({
      kind: 'handled',
    });
    expect(channel.sent[0]?.text).toBe('Media setup: LTX configured; music analyzer missing.');
  });

  it('answers with the required config key when media is off', async () => {
    const { context: commandContext } = context({ enabled: false });
    await expect(handleRemoteMediaCommand(event('/video'), commandContext, 'd-1')).resolves.toEqual(
      { kind: 'rejected', reason: 'media is off: set media.enabled' },
    );
    await expect(handleRemoteMediaCommand(event('/music'), commandContext, 'd-2')).resolves.toEqual(
      { kind: 'rejected', reason: 'media is off: set media.enabled' },
    );
  });

  it('queues a normal video turn with the shipped skill and image path', async () => {
    const committed = vi.fn();
    const queue = vi.fn(async () => ({ kind: 'accepted' as const }));
    const { context: commandContext } = context({ queued: queue, markCommitted: committed });
    const still = {
      name: 'photo.jpg',
      mediaType: 'image/jpeg',
      relativePath: 'conv/request/photo.jpg',
      bytes: 10,
    };
    expect(
      await handleRemoteMediaCommand(
        event('/video drift left', [still]),
        commandContext,
        'dedup-video',
      ),
    ).toEqual({ kind: 'accepted' });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/video drift left' }),
      expect.stringContaining('Load the video-clip skill using load_skill'),
      'dedup-video',
      'video',
    );
    expect(committed).toHaveBeenCalledOnce();
  });

  it('queues music with the audio source and rejects an image as its source', async () => {
    const queue = vi.fn(async () => ({ kind: 'queued' as const }));
    const { context: commandContext } = context({ queued: queue });
    const audio = {
      name: 'voice.ogg',
      mediaType: 'audio/ogg',
      relativePath: 'conv/request/voice.ogg',
      bytes: 10,
    };
    expect(
      await handleRemoteMediaCommand(
        event('/music soften the beat', [audio]),
        commandContext,
        'dedup-music',
      ),
    ).toEqual({ kind: 'queued' });
    expect(queue).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Load the music-track skill using load_skill'),
      'dedup-music',
      'music',
    );
    await expect(
      handleRemoteMediaCommand(
        event('/music', [{ ...audio, mediaType: 'image/jpeg' }]),
        commandContext,
        'dedup-bad',
      ),
    ).resolves.toMatchObject({
      kind: 'rejected',
      reason: '/music accepts audio files as attachments',
    });
  });
});
