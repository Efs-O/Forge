import { describe, expect, it, vi } from 'vitest';
import { RemoteApprovalBridge } from '../../src/remote/RemoteApprovalBridge';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import type { RemoteAuth } from '../../src/remote/RemoteAuth';
import type { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { ToolApprovalRequestEvent, ToolApprovalSink } from '../../src/sidebar/ToolApprovalService';

describe('remote Always in this project approval', () => {
  it('offers the project button, resolves it as alwaysProject, and returns the save notice', async () => {
    const channel = new FakeRemoteChannel();
    let sink: ToolApprovalSink | undefined;
    const resolveApproval = vi.fn();
    const host = {
      addApprovalSink: (value: ToolApprovalSink) => {
        sink = value;
        return { dispose: () => (sink = undefined) };
      },
      resolveApproval,
      status: () => ({
        activeConversationId: 'conversation-1',
        conversations: [],
        requestChains: [{ conversationId: 'conversation-1', remoteRequestId: 'request-1' }],
        streamingConversationIds: [],
      }),
    } as unknown as ForgeHostFacade;
    const store = {
      getRequest: () => ({ id: 'request-1', channel: 'fake', chatId: 'chat-1' }),
      bindingsForConversation: () => [],
    } as unknown as RemoteRequestStore;
    const auth = {
      canDeliver: async () => true,
      approvalNonce: async () => 'nonce-1',
    } as unknown as RemoteAuth;
    const bridge = new RemoteApprovalBridge(
      channel,
      store,
      auth,
      host,
      new AbortController().signal,
      4_000,
    );
    bridge.start({ suspendFooter: vi.fn(), resumeFooter: vi.fn() } as never);
    const gate: ToolApprovalRequestEvent = {
      id: 'gate-1',
      toolName: 'message_chat',
      detail: 'Send the message',
      dangerous: false,
      conversationId: 'conversation-1',
      allowForChat: { keys: ['cross_chat'], label: 'messages to other chats' },
      alwaysInProject: { keys: ['cross_chat'], label: 'messages to other chats' },
    };
    sink?.requested(gate);
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]).toMatchObject({
      approvalAlwaysInProject: true,
      text: expect.stringContaining('Always in this project covers: messages to other chats.'),
    });

    const correlationId = channel.sent[0]?.correlationId;
    if (!correlationId) throw new Error('approval correlation id was not sent');
    const action: Extract<RemoteInboundEvent, { kind: 'action' }> = {
      kind: 'action',
      channel: 'fake',
      providerMessageId: 'callback-1',
      senderId: 'owner',
      chatId: 'chat-1',
      chatType: 'private',
      receivedAt: 1,
      action: 'always_project',
      correlationId,
    };
    expect(bridge.resolveAction(action, 'nonce-1')).toBe(true);
    expect(resolveApproval).toHaveBeenCalledWith('gate-1', 'alwaysProject');

    sink?.resolved({
      ...gate,
      approved: true,
      decision: 'alwaysProject',
      reason: 'resolved',
      approvalNotice: 'Always in this project saved (messages to other chats).',
    });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    expect(channel.sent[1]?.text).toBe('Always in this project saved (messages to other chats).');
    bridge.stop();
  });
});
