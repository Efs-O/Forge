import { describe, expect, it, vi } from 'vitest';
import { callIndex, traceChatCalls, traceWorkingLine } from '../support/chatCalls';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteApprovalBridge } from '../../src/remote/RemoteApprovalBridge';
import { RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';
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
    /** `canDeliver` rejects, the way a SecretStorage read behind it can. */
    canDeliverThrows?: boolean;
    onError?: (message: string) => void;
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
    canDeliver: async () => {
      if (options.canDeliverThrows) throw new Error('secret read failed');
      return true;
    },
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
    options.onError,
    options.cleanup,
  );
  bridge.start();
  const gateEvent = (over: {
    waitingForOwner?: boolean;
    allowForChat?: { keys: string[]; label: string };
  } = {}) => ({
    id: 'gate-1',
    toolName: options.toolName ?? 'write_file',
    detail: options.detail ?? 'src/index.ts',
    dangerous: options.dangerous ?? false,
    conversationId: 'c1',
    ...(over.waitingForOwner ? { waitingForOwner: true } : {}),
    ...(over.allowForChat ? { allowForChat: over.allowForChat } : {}),
  });
  const request = (over: {
    waitingForOwner?: boolean;
    allowForChat?: { keys: string[]; label: string };
  } = {}): void =>
    sink?.requested(gateEvent(over));
  /** What `ToolApprovalService` does right after that re-announce: say out loud
   *  that nobody but the owner can answer this card now. */
  const waitingForOwner = (): void =>
    sink?.waitingForOwner?.(gateEvent({ waitingForOwner: true }));
  const resolve = (
    approved: boolean,
    reason: 'resolved' | 'cancelled' | 'timeout' = 'resolved',
  ): void =>
    sink?.resolved({
      id: 'gate-1',
      toolName: 'write_file',
      detail: 'src/index.ts',
      dangerous: false,
      conversationId: 'c1',
      approved,
      decision: approved ? 'approve' : 'decline',
      reason,
    });
  const resolveDecision = (decision: 'approve' | 'allowChat' | 'decline'): void =>
    sink?.resolved({
      ...gateEvent({
        allowForChat: { keys: ['cross_chat'], label: 'messages to other chats' },
      }),
      approved: decision !== 'decline',
      decision,
      reason: 'resolved',
    });
  return { bridge, channel, request, waitingForOwner, resolve, resolveDecision, resolveApproval };
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
      decision: approved ? 'approve' : 'decline',
      reason: 'resolved',
    });
  return { bridge, request, resolve };
}

/**
 * The same bridge with the working-line pair wired, as `RemoteController.start()`
 * does it: the card and the turn's status bubble share one chat, and which of
 * them is last on screen is what the owner sees.
 */
function workingLineRig() {
  const channel = new FakeRemoteChannel();
  const calls = traceChatCalls(channel);
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
  const signal = new AbortController().signal;
  const progress = new RemoteAgentProgress(channel, signal, () => true, 4_000, 0);
  progress.begin('c1', 'chat-1', 'message-1', 'remote');
  progress.handle({ conversationId: 'c1', kind: 'narration', text: 'Writing it.' });
  const bridge = new RemoteApprovalBridge(channel, store, auth, host, signal, 4_000);
  bridge.start(traceWorkingLine(progress, calls));
  const gate = {
    id: 'gate-1',
    toolName: 'write_file',
    detail: 'src/index.ts',
    dangerous: false,
    conversationId: 'c1',
  };
  return {
    bridge,
    channel,
    calls,
    progress,
    request: () => sink?.requested(gate),
    resolve: (approved: boolean) =>
      sink?.resolved({
        ...gate,
        approved,
        decision: approved ? 'approve' : 'decline',
        reason: 'resolved',
      }),
  };
}

describe('RemoteApprovalBridge', () => {
  it('asks the chat that queued the turn', async () => {
    const { channel, request } = rig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.chatId).toBe('chat-1');
    expect(channel.sent[0]?.text).toContain('write_file');
  });

  it('reports an approval publish that rejected, instead of waiting for a card', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const onError = vi.fn();
      const { channel, request } = rig({ canDeliverThrows: true, onError });
      request();
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledWith('Forge remote approval publish: secret read failed'),
      );
      // Nothing reached the phone, so the gate is still open and a republish
      // after the read starts working can still put the card up.
      expect(channel.sent).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('offers the same chat rule over Telegram and resolves the callback as allowChat', async () => {
    const { bridge, channel, request, resolveApproval, resolveDecision } = rig();
    request({
      allowForChat: { keys: ['cross_chat'], label: 'messages to other chats' },
    });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]).toMatchObject({
      approvalAllowChat: true,
      text: expect.stringContaining(
        'Allow for this chat covers: messages to other chats.',
      ),
    });

    const correlationId = channel.sent[0]?.correlationId;
    expect(correlationId).toBeTruthy();
    expect(
      bridge.resolveAction(
        {
          kind: 'action',
          channel: 'fake',
          chatId: 'chat-1',
          senderId: 's1',
          chatType: 'private',
          action: 'allow_chat',
          correlationId: correlationId as string,
        },
        'nonce-1',
      ),
    ).toBe(true);
    expect(resolveApproval).toHaveBeenCalledWith('gate-1', 'allowChat');

    resolveDecision('allowChat');
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    await vi.waitFor(() => expect(channel.resolvedKeyboards).toHaveLength(1));
    // The greyed-out button and the receipt must agree about WHICH answer this
    // was: `approve` ran one call, `allowChat` wrote a rule that answers every
    // later one, and a card that cannot tell them apart tells the owner nothing
    // about what happens next time.
    expect(channel.resolvedKeyboards[0]?.decision).toBe('allowChat');
    expect(channel.sent[1]?.text).toBe(
      'Forge approval allowed for this chat (messages to other chats).',
    );
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
    expect(resolveApproval).toHaveBeenCalledWith('gate-1', 'approve');
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
        decision: approved ? 'approve' : 'decline',
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

  /** A re-announce of the SAME gate keeps its entry, so every keyboard the gate
   *  has ever put up is still remembered when it is answered. A fresh entry
   *  would forget the earlier keyboard, leaving a live Approve button for a
   *  decision that has already been made. This is the plain re-announce path (no
   *  waiting-for-owner flag): the one a future re-post takes, and the shape
   *  `republish` after a re-pair produces. The waiting-for-owner re-announce
   *  no longer puts up a card at all -- the next two tests pin that. */
  it('keeps every keyboard a re-announced gate put up, so no Approve button survives', async () => {
    const { channel, request, resolve } = rig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    expect(channel.sent[1]!.text).toContain('write_file');
    resolve(true);
    await vi.waitFor(() => expect(channel.resolvedKeyboards).toHaveLength(1));
    expect(channel.resolvedKeyboards[0]?.keyboardMessageIds).toEqual(['sent-1', 'sent-2']);
  });

  /**
   * When the service says only the owner can settle a gate, the phone gets
   *  ONE line saying this gate now waits for the owner -- not a second
   *  Approve/Deny card. The re-announce used
   * to publish the whole card again, so the owner had two live keyboards for
   * one decision, and the "Waiting for you." note the service appends to the
   * detail is the first thing clipped off a card that is too long for the
   * transport. Revert the fix (publish a re-announce like any other request)
   * and this sees three messages, two of them carrying keyboards, and the
   * keyboard left behind by the answer is the wrong one.
   */
  it('tells the owner once that only they can answer, without a second card', async () => {
    const { bridge, channel, request, waitingForOwner, resolve } = rig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    request({ waitingForOwner: true });
    waitingForOwner();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    const notice = channel.sent[1]!;
    expect(notice.text).toContain('write_file is waiting for you');
    expect(notice.text).toContain('nothing but your answer settles it');
    // A plain line, not a card: no correlationId means the transport hangs no
    // Approve/Deny row on it, so the card that opened stays the one surface the
    // owner can answer from, and a spoken reply to the line still names it.
    expect(notice.correlationId).toBeUndefined();
    expect(notice.parseMode).toBeUndefined();
    expect(channel.sent.filter((message) => message.correlationId)).toHaveLength(1);
    expect(bridge.pendingGates('chat-1')[0]?.messageIds).toEqual(['sent-1', 'sent-2']);
    // And the notice is not mistaken for a keyboard that has to be greyed out.
    resolve(true, 'resolved');
    await vi.waitFor(() => expect(channel.resolvedKeyboards).toHaveLength(1));
    expect(channel.resolvedKeyboards[0]?.keyboardMessageIds).toEqual(['sent-1']);
  });

  /** The line has to survive a card the transport cannot carry whole: the note
   *  the service appends to the detail is cut from the end of a long card, so
   *  an owner who only ever sees the card stops being told the wait is on them.
   */
  it('says it in plain words when the card is too long to carry the note', async () => {
    const note =
      'No automated answer is allowed for this gate, so it waits for you: ' +
      'no answer within 2 min from anyone else counts. Waiting for you.';
    const { channel, request, waitingForOwner } = rig({
      detail: `${'a'.repeat(4_500)}\n${note}`,
    });
    channel.declareHtmlSupport();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]!.text).not.toContain('Waiting for you.');
    request({ waitingForOwner: true });
    waitingForOwner();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    expect(channel.sent[1]!.text).toContain('is waiting for you');
    expect(channel.sent[1]!.text).toContain('write_file');
  });

  /** A gate no automated answer may settle opens already waiting for the owner,
   *  so its FIRST announce carries the flag: the card must still go out (it is
   *  the surface the owner answers from) and the line must come exactly once,
   *  no matter which of the two paths raises it first.
   */
  it('gives a gate nobody may answer automatically its card and its one line', async () => {
    const { channel, request, waitingForOwner } = rig({ toolName: 'web_fetch' });
    request({ waitingForOwner: true });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.correlationId).toBeTruthy();
    waitingForOwner();
    waitingForOwner();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    expect(channel.sent[1]!.text).toContain('web_fetch is waiting for you');
    // A later announce of the same gate says it again to nobody: one line per
    // gate, so a phone is not spammed at a card the owner is already reading.
    waitingForOwner();
    await new Promise((settled) => setTimeout(settled, 0));
    expect(channel.sent).toHaveLength(2);
  });

  /** A late announce about a gate that has already been answered says nothing:
   *  a "waiting for you" line arriving after the receipt reads to the owner as
   *  a fresh request they have to answer a second time.
   */
  it('says nothing about a gate the owner has already answered', async () => {
    const { channel, request, waitingForOwner, resolve } = rig();
    request({ waitingForOwner: true });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    resolve(false, 'resolved');
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    expect(channel.sent[1]?.text).toContain('denied');
    waitingForOwner();
    await new Promise((settled) => setTimeout(settled, 0));
    expect(channel.sent).toHaveLength(2);
  });

  /** AC 1a: the mirror shows the same line the chat shows, naming how the
   *  card left the queue. A phone that reads "approved" alone cannot tell an
   *  owner's answer from a timeout. */
  it('sends the receipt line naming how the card was settled', async () => {
    const { channel, request, resolve } = rig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    resolve(true);
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    expect(channel.sent[1]?.text).toBe('Forge approval approved (resolved).');
  });

  it('sends the same line for a denial, so a decline cannot read as an approval', async () => {
    const { channel, request, resolve } = rig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    resolve(false, 'cancelled');
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    expect(channel.sent[1]?.text).toBe('Forge approval denied (cancelled).');
  });

  it('edits a timed-out approval card and does not send a second message', async () => {
    const { channel, request, resolve } = rig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));

    resolve(false, 'timeout');

    await vi.waitFor(() => expect(channel.resolvedKeyboards).toHaveLength(1));
    expect(channel.resolvedKeyboards[0]).toMatchObject({
      approved: false,
      reason: 'timeout',
      keyboardMessageIds: ['sent-1'],
    });
    expect(channel.sent).toHaveLength(1);
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

  it('hides the working line while a card waits and reopens it below the receipt', async () => {
    const { channel, calls, request, resolve } = workingLineRig();
    request();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    // An approval card is an owner wait like a question board, so it gets the
    // same treatment: the line above the Approve/Deny row comes off, and the
    // bubble keeps its words and its Stop button while somebody decides.
    expect(callIndex(calls, 'send Forge approval')).toBeLessThan(callIndex(calls, 'hide c1'));
    expect(channel.edits.at(-1)?.text).toBe('Writing it.');
    expect(channel.stopButtons.has('message-1')).toBe(true);
    expect(channel.progress).toEqual([]);

    resolve(true);
    await vi.waitFor(() => expect(channel.progress).toHaveLength(1));
    // The decision receipt first, then the working line below it.
    const receipt = callIndex(calls, 'send Forge approval approved');
    const show = callIndex(calls, 'show c1');
    const reopened = callIndex(calls, 'progress ');
    expect(show).toBeGreaterThan(receipt);
    expect(reopened).toBeGreaterThan(show);
    expect(channel.progress.at(-1)?.text).toContain('Working…');
    expect(channel.edits.at(-1)?.text).toBe('Writing it.');
  });
});
