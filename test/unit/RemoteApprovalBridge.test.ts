import { describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteApprovalBridge } from '../../src/remote/RemoteApprovalBridge';
import type { CommandCleanupScheduler } from '../../src/remote/CommandCleanupScheduler';
import type { RemoteAuth } from '../../src/remote/RemoteAuth';
import type { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { ToolApprovalSink } from '../../src/sidebar/ToolApprovalService';
import { correlateGate, recordingWindow } from '../../src/voice/VoiceGrammar';

function rig(
  options: {
    remoteRequestId?: string | undefined;
    boundChatId?: string;
    cleanup?: CommandCleanupScheduler;
  } = {},
) {
  const channel = new FakeRemoteChannel();
  let sink: ToolApprovalSink | undefined;
  const resolveApproval = vi.fn();
  const store = {
    getRequest: (id: string) =>
      id === 'req-1' ? { id: 'req-1', channel: 'fake', chatId: 'chat-1' } : undefined,
    bindingsForConversation: () =>
      options.boundChatId
        ? [{ channel: 'fake', chatId: options.boundChatId, workspaceId: 'w', conversationId: 'c1' }]
        : [],
  } as unknown as RemoteRequestStore;
  const auth = {
    canDeliver: async () => true,
    approvalNonce: async () => 'nonce-1',
  } as unknown as RemoteAuth;
  const host = {
    addApprovalSink: (added: ToolApprovalSink) => {
      sink = added;
      return { dispose: () => (sink = undefined) };
    },
    resolveApproval,
    status: () => ({
      activeConversationId: 'c1',
      conversations: [],
      requestChains: [
        {
          conversationId: 'c1',
          ...('remoteRequestId' in options
            ? { remoteRequestId: options.remoteRequestId }
            : { remoteRequestId: 'req-1' }),
        },
      ],
      streamingConversationIds: [],
    }),
  } as unknown as ForgeHostFacade;
  const bridge = new RemoteApprovalBridge(
    channel,
    store,
    auth,
    host,
    new AbortController().signal,
    4_000,
    undefined,
    options.cleanup,
  );
  bridge.start();
  const request = (): void =>
    sink?.requested({
      id: 'gate-1',
      toolName: 'write_file',
      detail: 'src/index.ts',
      dangerous: false,
      conversationId: 'c1',
    });
  const resolve = (approved: boolean): void =>
    sink?.resolved({
      id: 'gate-1',
      toolName: 'write_file',
      detail: 'src/index.ts',
      dangerous: false,
      conversationId: 'c1',
      approved,
      reason: 'resolved',
    });
  return { bridge, channel, request, resolve, resolveApproval };
}

describe('RemoteApprovalBridge', () => {
  it('asks the chat that queued the turn', async () => {
    const { channel, request } = rig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.chatId).toBe('chat-1');
    expect(channel.sent[0]?.text).toContain('write_file');
  });

  it('asks the bound chat when the turn was started in the sidebar', async () => {
    const { bridge, channel, request, resolveApproval } = rig({
      remoteRequestId: undefined,
      boundChatId: 'chat-9',
    });
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.chatId).toBe('chat-9');

    const correlationId = channel.sent[0]?.correlationId;
    expect(correlationId).toBeTruthy();
    expect(
      bridge.resolveAction(
        {
          kind: 'action',
          channel: 'fake',
          chatId: 'chat-9',
          senderId: 's1',
          chatType: 'private',
          action: 'approve',
          correlationId: correlationId as string,
        },
        'nonce-1',
      ),
    ).toBe(true);
    expect(resolveApproval).toHaveBeenCalledWith('gate-1', true);
  });

  it('lets a spoken reply to the approval message name its gate', async () => {
    const { bridge, channel, request } = rig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    const gates = bridge.pendingGates('chat-1');
    const window = recordingWindow(Date.now() + 10_000, 1_000);
    // A second gate makes the timing rule refuse; the reply still names one.
    const both = [...gates, { id: 'other', chatId: 'chat-1', openedAt: 0 }];
    expect(correlateGate(both, 'chat-1', window)).toMatchObject({ kind: 'refuse' });
    expect(correlateGate(both, 'chat-1', window, 'sent-1')).toMatchObject({
      kind: 'resolve',
      gate: { id: 'gate-1' },
    });
  });

  it('clears an approved receipt after the reply delay but keeps a denial', async () => {
    for (const approved of [true, false]) {
      const armEphemeral = vi.fn();
      const cleanup = { armEphemeral } as unknown as CommandCleanupScheduler;
      const { channel, request, resolve } = rig({ cleanup });
      request();
      await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
      resolve(approved);
      await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
      expect(channel.sent[1]?.text).toContain(approved ? 'approved' : 'denied');
      if (approved) expect(armEphemeral).toHaveBeenCalledWith('chat-1', expect.any(Array));
      else expect(armEphemeral).not.toHaveBeenCalled();
    }
  });

  it('stays silent when no chat is queued and none is bound', async () => {
    const { channel, request } = rig({ remoteRequestId: undefined });
    request();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(channel.sent).toHaveLength(0);
  });
});
