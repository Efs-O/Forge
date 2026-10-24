import { describe, expect, it, vi } from 'vitest';
import {
  admitRemotePrompt,
  resumeRemoteConversation,
} from '../../src/remote/RemotePromptAdmission';
import type { RemoteInboundEvent } from '../../src/remote/types';

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
