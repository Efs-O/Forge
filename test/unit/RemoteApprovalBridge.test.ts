import { describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteApprovalBridge } from '../../src/remote/RemoteApprovalBridge';
import type { CommandCleanupScheduler } from '../../src/remote/CommandCleanupScheduler';
import type { RemoteAuth } from '../../src/remote/RemoteAuth';
import type { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { ToolApprovalSink } from '../../src/sidebar/ToolApprovalService';
import type { RemoteChannel } from '../../src/remote/types';
import { correlateGate, recordingWindow } from '../../src/voice/VoiceGrammar';

function rig(
  options: {
    remoteRequestId?: string | undefined;
    boundChatId?: string;
    cleanup?: CommandCleanupScheduler;
    toolName?: string;
    detail?: string;
    dangerous?: boolean;
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
      toolName: options.toolName ?? 'write_file',
      detail: options.detail ?? 'src/index.ts',
      dangerous: options.dangerous ?? false,
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

/** Same rig, with a caller-supplied channel and error sink, for the failure path. */
function rigWithChannel(channel: RemoteChannel, onError?: (message: string) => void) {
  let sink: ToolApprovalSink | undefined;
  const store = {
    getRequest: (id: string) =>
      id === 'req-1' ? { id: 'req-1', channel: 'fake', chatId: 'chat-1' } : undefined,
    bindingsForConversation: () => [],
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
    resolveApproval: vi.fn(),
    status: () => ({
      activeConversationId: 'c1',
      conversations: [],
      requestChains: [{ conversationId: 'c1', remoteRequestId: 'req-1' }],
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
    onError,
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
  return { bridge, request, resolve };
}

describe('RemoteApprovalBridge', () => {
  it('asks the chat that queued the turn', async () => {
    const { channel, request } = rig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.chatId).toBe('chat-1');
    expect(channel.sent[0]?.text).toContain('write_file');
  });

  it('uses escaped, clipped Telegram approval cards and keeps the plain prompt unchanged', async () => {
    const regular = rig();
    regular.channel.declareHtmlSupport();
    regular.request();
    await vi.waitFor(() => expect(regular.channel.sent).toHaveLength(1));
    expect(regular.channel.sent[0]).toMatchObject({
      text: '<b>Approve write_file?</b>\n<pre>src/index.ts</pre>',
      parseMode: 'HTML',
    });

    const dangerous = rig({
      dangerous: true,
      toolName: 'write<&>',
      detail: '<script>alert(1)</script>'.repeat(2_000),
    });
    dangerous.channel.declareHtmlSupport();
    dangerous.request();
    await vi.waitFor(() => expect(dangerous.channel.sent).toHaveLength(1));
    const html = dangerous.channel.sent[0]!.text;
    expect(html.startsWith('<b>⚠ Dangerous: write&lt;&amp;&gt;</b>\n<pre>')).toBe(true);
    expect(html.endsWith('</pre>')).toBe(true);
    expect([...html].length).toBeLessThanOrEqual(4_000);
    expect(html).not.toContain('<script>');

    const plain = rig({ dangerous: true });
    plain.request();
    await vi.waitFor(() => expect(plain.channel.sent).toHaveLength(1));
    expect(plain.channel.sent[0]?.text).toBe('Forge approval DANGEROUS: write_file\nsrc/index.ts');
    expect(plain.channel.sent[0]?.parseMode).toBeUndefined();
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
    expect(channel.sent).toHaveLength(0);
  });

  /**
   * Phase 1: resolution greys the button row out rather than deleting it, and
   * it must reach every message that ever carried a keyboard for the gate.
   */
  it('greys the approval row with the outcome instead of retracting it', async () => {
    for (const approved of [true, false]) {
      const { channel, request, resolve } = rig();
      request();
      await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
      const correlationId = channel.sent[0]?.correlationId as string;
      resolve(approved);
      await vi.waitFor(() => expect(channel.resolvedKeyboards).toHaveLength(1));
      expect(channel.resolvedKeyboards[0]).toEqual({
        chatId: 'chat-1',
        correlationId,
        keyboardMessageIds: ['sent-1'],
        approved,
      });
      expect(channel.retracted).toEqual([]);
    }
  });

  it('greys every keyboard left by a republished approval prompt', async () => {
    const { bridge, channel, request, resolve } = rig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    bridge.republish('chat-1');
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    resolve(true);
    await vi.waitFor(() => expect(channel.resolvedKeyboards).toHaveLength(1));
    expect(channel.resolvedKeyboards[0]?.keyboardMessageIds).toEqual(['sent-1', 'sent-2']);
  });

  /**
   * A transport with no button affordance (WhatsApp) keeps the old behaviour:
   * the keyboard is retracted, not greyed out.
   */
  it('falls back to retracting the keyboard on a channel that cannot grey a button', async () => {
    const retracted: Array<{ chatId: string; correlationId: string }> = [];
    const plain: RemoteChannel = {
      name: 'fake',
      onEvent: () => ({ dispose: () => undefined }),
      start: async () => undefined,
      send: async (chatId, _text, options) => [`m-${options?.correlationId ?? 'x'}`],
      retractPrompt: async (chatId, correlationId) => {
        retracted.push({ chatId, correlationId });
      },
    };
    const { request, resolve } = rigWithChannel(plain);
    request();
    resolve(false);
    await vi.waitFor(() =>
      expect(retracted).toEqual([{ chatId: 'chat-1', correlationId: expect.any(String) }]),
    );
  });

  it('reports a keyboard it could not resolve, and still sends the receipt', async () => {
    const onError = vi.fn();
    const channel = new FakeRemoteChannel();
    channel.resolveKeyboardError = 'HTTP 400';
    const { request, resolve } = rigWithChannel(channel, onError);
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    resolve(false);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0]?.[0]).toContain('could not be resolved');
    // A stuck button is a complaint, not a reason to lose the receipt.
    await vi.waitFor(() => expect(channel.sent.at(-1)?.text).toContain('denied'));
  });
});
