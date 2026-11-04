import { describe, expect, it, vi } from 'vitest';
import {
  admitRemotePrompt,
  resumeRemoteConversation,
} from '../../src/remote/RemotePromptAdmission';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { RemoteRequestRecord } from '../../src/remote/types';

const event = {
  kind: 'text',
  channel: 'telegram',
  chatId: 'chat',
  text: 'hello',
  providerMessageId: 'message',
  senderId: 'owner',
  chatType: 'private',
  receivedAt: 1,
} as const satisfies Extract<RemoteInboundEvent, { kind: 'text' }>;

function dependencies() {
  const binding = {
    channel: 'telegram',
    chatId: 'chat',
    workspaceId: 'forge-id',
    conversationId: 'conversation',
  };
  return {
    channel: {} as never,
    store: {
      getByDedupKey: () => undefined,
      binding: () => binding,
    } as never,
    host: {} as never,
    options: {
      workspaceId: 'acemar-id',
      workspaceNamesById: { 'forge-id': 'Forge' },
      currentWorkspaceName: 'acemar',
      currentWorkspaceAlias: 'acemar',
      queueLimit: 10,
      attachmentsEnabled: false,
      acceptPdfAttachments: false,
    },
    isBusy: () => false,
    kickDrain: vi.fn(),
  };
}

describe('bound workspace refusal', () => {
  it('names the bound workspace and move command for prompt admission', async () => {
    const result = await admitRemotePrompt(event, event.text, 'dedup', dependencies());
    expect(result).toEqual({
      kind: 'rejected',
      reason:
        'this chat is bound to Forge — send /workspace acemar to move it here, or /workspace to pick',
    });
  });

  it('uses the same actionable message for resume admission', async () => {
    const result = await resumeRemoteConversation(event, 'dedup', {
      ...dependencies(),
      restoreConversation: vi.fn(),
    });
    expect(result).toEqual({
      kind: 'rejected',
      reason:
        'this chat is bound to Forge — send /workspace acemar to move it here, or /workspace to pick',
    });
  });
});

describe('media prompt attachment paths', () => {
  it('decorates the durable turn with the saved run-input source path', async () => {
    const records: RemoteRequestRecord[] = [];
    const base = dependencies();
    const deps = {
      ...base,
      options: {
        ...base.options,
        workspaceId: 'forge-id',
        attachmentsEnabled: true,
        attachmentStore: {
          save: async () => [
            {
              name: 'voice.ogg',
              mediaType: 'audio/ogg',
              relativePath: 'conversation/request/voice.ogg',
              bytes: 5,
            },
          ],
        },
      },
      store: {
        getByDedupKey: () => undefined,
        binding: () => ({
          channel: 'telegram',
          chatId: 'chat',
          workspaceId: 'forge-id',
          conversationId: 'conversation',
        }),
        queued: () => [],
        enqueue: async (request: RemoteRequestRecord) => {
          records.push(request);
          return true;
        },
      },
    };
    const withAudio = {
      ...event,
      attachments: [
        {
          name: 'voice.ogg',
          mediaType: 'audio/ogg',
          providerFileId: 'audio-1',
          data: 'dm9pY2U=',
        },
      ],
    } satisfies Extract<RemoteInboundEvent, { kind: 'text' }>;

    const result = await admitRemotePrompt(
      withAudio,
      'Load the music-track skill.',
      'dedup-audio',
      deps as never,
      undefined,
      (text, attachments) =>
        `${text}\nsource_audio_path: .forge/remote-inbox/${attachments[0]?.relativePath}`,
    );

    expect(result.kind).toBe('accepted');
    expect(records[0]?.text).toContain(
      'source_audio_path: .forge/remote-inbox/conversation/request/voice.ogg',
    );
    expect(records[0]?.attachments?.[0]?.mediaType).toBe('audio/ogg');
  });
});
