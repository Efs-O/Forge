import type { RemoteCommandContext } from './RemoteCommandHandler';
import type { RemoteInboundEvent, RemoteInboundDisposition } from './types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

/** Telegram media commands become ordinary queued turns with the shipped skill named up front. */
export async function handleRemoteMediaCommand(
  event: TextEvent,
  context: RemoteCommandContext,
  dedupKey: string,
): Promise<RemoteInboundDisposition | undefined> {
  const [command, ...operands] = event.text.trim().split(/\s+/u);
  if (command === '/media') {
    await context.channel.send(
      event.chatId,
      context.mediaCommands?.setupText ?? 'Media setup status is unavailable in this window.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command !== '/video' && command !== '/music') return undefined;
  const media = context.mediaCommands;
  if (!media?.enabled) return { kind: 'rejected', reason: 'media is off: set media.enabled' };

  const kind = command === '/video' ? 'video' : 'music';
  const attachments = event.attachments ?? [];
  const expected = kind === 'video' ? 'image/' : 'audio/';
  if (attachments.some((attachment) => !attachment.mediaType.startsWith(expected))) {
    return {
      kind: 'rejected',
      reason:
        kind === 'video'
          ? '/video accepts still images as attachments'
          : '/music accepts audio files as attachments',
    };
  }
  const request = operands.join(' ').trim();
  const prompt = kind === 'video' ? videoPrompt(request) : musicPrompt(request);
  const result = await media.queue(event, prompt, dedupKey, kind);
  if (result.kind === 'accepted' || result.kind === 'queued') context.markCommitted?.();
  return result;
}

function videoPrompt(request: string): string {
  return [
    'The user started this request with Telegram /video. Load the video-clip skill using load_skill, then follow its guidance.',
    request ? `Request: ${request}` : 'Ask what motion and scene they want for the clip.',
    'Use any Telegram still-image attachment path included below as image_path when calling generate_video.',
  ].join('\n');
}

function musicPrompt(request: string): string {
  return [
    'The user started this request with Telegram /music. Load the music-track skill using load_skill, then follow its guidance and ask before generating.',
    request ? `Request: ${request}` : 'Ask for the style prompt and lyrics choice.',
    'If a Telegram audio attachment path is included below, use it as source_audio_path in generate_music.',
  ].join('\n');
}
