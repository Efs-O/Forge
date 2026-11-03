import { describe, expect, it, vi } from 'vitest';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { handleRemoteSettingsCommand } from '../../src/remote/remoteSettingsCommands';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

describe('remote /approvals command', () => {
  it('lists and resets the bound chat through the host facade', async () => {
    const conversation = {
      id: 'bound-chat',
      title: 'Bound',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      approval_rules: ['cross_chat'],
    } as ConversationRuntime;
    const channel = new FakeRemoteChannel();
    const resetApprovals = vi.fn(async () => true);
    const context = {
      channel,
      store: {
        binding: () => ({ conversationId: conversation.id }),
      },
      host: {
        getConversation: () => conversation,
        resetApprovals,
      },
      signal: new AbortController().signal,
    } as unknown as RemoteCommandContext;
    const event = {
      kind: 'text' as const,
      channel: 'fake' as const,
      providerMessageId: 'message-1',
      senderId: 'owner',
      chatId: 'remote-chat',
      chatType: 'private' as const,
      receivedAt: Date.now(),
      text: '/approvals',
    };

    await expect(
      handleRemoteSettingsCommand('/approvals', undefined, event, context),
    ).resolves.toEqual({ kind: 'handled' });
    expect(channel.sent[0]?.text).toContain('messages to other chats  (cross_chat)');
    expect(channel.sent[0]?.chatId).toBe('remote-chat');

    await expect(
      handleRemoteSettingsCommand('/approvals', 'reset', event, context),
    ).resolves.toEqual({ kind: 'handled' });
    expect(resetApprovals).toHaveBeenCalledWith(conversation.id);
    expect(channel.sent[1]?.text).toContain('Forge: approvals reset for this chat');
  });
});
