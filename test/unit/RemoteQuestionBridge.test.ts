import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openQuickInputs } from '../support/vscode';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import type { CommandCleanupScheduler } from '../../src/remote/CommandCleanupScheduler';
import { RemoteQuestionBridge } from '../../src/remote/RemoteQuestionBridge';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { RemoteInboundEvent } from '../../src/remote/types';

beforeEach(() => { openQuickInputs.length = 0; });

function bridgeRig(
  options: {
    canDeliver?: boolean;
    remoteRequestId?: string | undefined;
    /** Chat bound to c1, standing in for a paired phone. */
    boundChatId?: string;
    channelName?: 'fake' | 'telegram';
    cleanup?: CommandCleanupScheduler;
  } = {},
) {
  const channel = new FakeRemoteChannel(options.channelName ?? 'fake');
  const service = new UserQuestionService();
  const channelName = options.channelName ?? 'fake';
  const store = {
    getRequest: (id: string) =>
      id === 'req-1' ? { id: 'req-1', channel: channelName, chatId: 'chat-1' } : undefined,
    bindingsForConversation: () =>
      options.boundChatId
        ? [
            {
              channel: channelName,
              chatId: options.boundChatId,
              workspaceId: 'w',
              conversationId: 'c1',
            },
          ]
        : [],
  } as unknown as RemoteRequestStore;
  const canDeliver = vi.fn(async () => options.canDeliver ?? true);
  const auth = { canDeliver } as unknown as RemoteAuth;
  const host = {
    addQuestionSink: (sink: Parameters<ForgeHostFacade['addQuestionSink']>[0]) =>
      service.addSink(sink),
    answerQuestion: (id: string, text: string) => service.answer(id, text),
    answerQuestionStructured: (id: string, answer: Parameters<UserQuestionService['answerStructured']>[1]) =>
      service.answerStructured(id, answer),
    skipQuestion: (id: string) => service.skip(id),
    dismissQuestion: (id: string) => service.dismiss(id),
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
  const bridge = new RemoteQuestionBridge(
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
  /**
   * Settles once the bridge has asked the session `calls` times and acted on
   * the answer, so a "nothing was sent" check cannot run before the send would.
   */
  const deliveryDecided = async (calls: number) => {
    await vi.waitFor(() => expect(canDeliver).toHaveBeenCalledTimes(calls));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { bridge, channel, service, deliveryDecided };
}

let questionCallbackSequence = 0;

function questionAction(
  questionId: string,
  action: 'select' | 'note' | 'next' | 'back' | 'skip',
  messageId: string,
  choice?: number,
): Extract<RemoteInboundEvent, { kind: 'question_action' }> {
  return {
    channel: 'telegram',
    kind: 'question_action',
    providerMessageId: `callback-${questionId}-${action}-${++questionCallbackSequence}`,
    senderId: 'owner-1',
    chatId: 'chat-1',
    chatType: 'private',
    receivedAt: Date.now(),
    questionId,
    action,
    ...(choice === undefined ? {} : { choice }),
    messageId,
  };
}

describe('RemoteQuestionBridge', () => {
  it('resolves a typed reply once, so numeric labels are not re-read as indexes', async () => {
    const { bridge, channel, service } = bridgeRig();
    const pending = service.ask({
      prompt: 'Which ports?',
      specs: [
        {
          prompt: 'Which ports?',
          multiSelect: true,
          options: [{ label: '3' }, { label: '1' }, { label: '2' }],
        },
      ],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));

    expect(bridge.answerText('chat-1', '1,2')).toBe(true);
    await expect(pending).resolves.toBe('3, 1');
  });

  it('sends the question to the chat that started the turn and answers from its reply', async () => {
    const { bridge, channel, service } = bridgeRig();
    const pending = service.ask({ prompt: 'Which file?', conversationId: 'c1' });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.text).toContain('Forge asks: Which file?');
    expect(bridge.hasPending('chat-1')).toBe(true);

    expect(bridge.answerText('chat-1', 'src/index.ts')).toBe(true);
    await expect(pending).resolves.toBe('src/index.ts');
  });

  it('numbers the options it offers', async () => {
    const { channel, service } = bridgeRig();
    void service.ask({
      prompt: 'Which backend?',
      options: ['llama.cpp', 'ollama'],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.text).toContain('1. llama.cpp');
    expect(channel.sent[0]?.text).toContain('2. ollama');
  });

  it('presents flat Telegram choices as buttons and answers the exact option', async () => {
    const { bridge, channel, service } = bridgeRig({ channelName: 'telegram' });
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({
      prompt: 'Which backend?',
      options: ['llama.cpp', 'ollama'],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.inlineKeyboards).toHaveLength(1));
    const questionId = asked.mock.calls[0]?.[0].id as string;
    const buttons = channel.inlineKeyboards[0]?.buttons.flat() ?? [];
    expect(buttons.map((button) => button.text)).toEqual([
      'llama.cpp',
      'ollama',
      'Note…',
      'Skip',
      'Send ✓',
    ]);
    expect(buttons[1]?.callbackData).toBe(`q:${questionId}:2`);

    await expect(
      bridge.handleAction(questionAction(questionId, 'select', 'keyboard-1', 2)),
    ).resolves.toEqual({ kind: 'handled' });
    expect(channel.inlineKeyboardReplacements.at(-1)?.buttons[1]?.[0]?.text).toBe('● ollama');
    await bridge.handleAction(questionAction(questionId, 'next', 'keyboard-1'));
    await expect(pending).resolves.toBe('ollama');
    expect(channel.clearedKeyboards).toEqual([{ chatId: 'chat-1', messageId: 'keyboard-1' }]);
  });

  it('makes Note an explicit free-text state and rejects stale buttons', async () => {
    const { bridge, channel, service } = bridgeRig({ channelName: 'telegram' });
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({
      prompt: 'Which backend?',
      options: ['llama.cpp', 'ollama'],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.inlineKeyboards).toHaveLength(1));
    const questionId = asked.mock.calls[0]?.[0].id as string;
    const note = questionAction(questionId, 'note', 'keyboard-1');
    await expect(bridge.handleAction(note)).resolves.toEqual({ kind: 'handled' });
    expect(service.hasPending('c1')).toBe(true);
    expect(channel.sent.at(-1)?.text).toContain('Send your note');
    const promptIds = [`sent-${channel.sent.length}`];
    expect(bridge.answerText('chat-1', 'use vllm')).toBe(true);
    await vi.waitFor(() => expect(channel.inlineKeyboardReplacements).toHaveLength(1));
    await bridge.handleAction(questionAction(questionId, 'next', 'keyboard-1'));
    await expect(pending).resolves.toBe('use vllm');
    await vi.waitFor(() => expect(channel.deleted.length).toBeGreaterThan(0));
    expect(channel.deleted.map((d) => d.messageId)).toEqual(promptIds);

    await expect(bridge.handleAction(note)).resolves.toEqual({
      kind: 'rejected',
      reason: 'question is stale or not owned by this chat',
    });
  });

  it('skips from Telegram and publishes a skipped receipt', async () => {
    const { bridge, channel, service } = bridgeRig({ channelName: 'telegram' });
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({
      prompt: 'Choose',
      options: ['A', 'B'],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.inlineKeyboards).toHaveLength(1));
    const id = asked.mock.calls[0]?.[0].id as string;
    await bridge.handleAction(questionAction(id, 'skip', 'keyboard-1'));
    await expect(pending).resolves.toContain('skipped this question');
    await vi.waitFor(() => expect(channel.sent.some((item) => item.text === 'Forge: skipped')).toBe(true));
    expect(channel.clearedKeyboards).toContainEqual({ chatId: 'chat-1', messageId: 'keyboard-1' });
  });

  it('keeps full long labels on buttons and answers button 2 as option 2', async () => {
    const { bridge, channel, service } = bridgeRig({ channelName: 'telegram' });
    const option77 = 'a'.repeat(77);
    const option164 = '🚀'.repeat(41);
    const pending = service.ask({
      prompt: 'Choose',
      options: [option77, option164],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.inlineKeyboards).toHaveLength(1));
    const questionId = channel.inlineKeyboards[0]?.buttons[1]?.[0]?.callbackData.split(':')[1];
    expect(channel.inlineKeyboards[0]?.buttons.flat().map((button) => button.text)).toEqual([
      option77,
      option164,
      'Note…',
      'Skip',
      'Send ✓',
    ]);
    expect(service.hasPending('c1')).toBe(true);
    expect(questionId).toBeTruthy();
    await expect(
      bridge.handleAction(questionAction(questionId!, 'select', 'keyboard-1', 2)),
    ).resolves.toEqual({ kind: 'handled' });
    await bridge.handleAction(questionAction(questionId!, 'next', 'keyboard-1'));
    await expect(pending).resolves.toBe(option164);
  });

  it('falls back to numbered text when there are more than 100 options', async () => {
    const { bridge, channel, service } = bridgeRig({ channelName: 'telegram' });
    const options = Array.from({ length: 101 }, (_, index) => `option-${index + 1}`);
    const pending = service.ask({ prompt: 'Choose', options, conversationId: 'c1' });
    await vi.waitFor(() =>
      expect(channel.sent.some((item) => item.text.includes('101. option-101'))).toBe(true),
    );
    expect(channel.inlineKeyboards).toHaveLength(0);
    expect(service.hasPending('c1')).toBe(true);
    expect(bridge.answerText('chat-1', '101')).toBe(true);
    await expect(pending).resolves.toBe('option-101');
  });

  it('does not report cancellation when another surface wins during button delivery', async () => {
    const { bridge, channel, service } = bridgeRig({ channelName: 'telegram' });
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({
      prompt: 'Which backend?',
      options: ['llama.cpp', 'ollama'],
      conversationId: 'c1',
    });
    const questionId = asked.mock.calls[0]?.[0].id as string;
    vi.spyOn(channel, 'sendInlineKeyboard').mockImplementation(async () => {
      service.answer(questionId, 'sidebar choice');
      throw new Error('Telegram unavailable');
    });
    await expect(pending).resolves.toBe('sidebar choice');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channel.sent.some((item) => item.text.includes('question was cancelled'))).toBe(false);
    expect(bridge.hasPending('chat-1')).toBe(false);
  });

  it('numbers each sub-question separately and says how to reply', async () => {
    const { channel, service } = bridgeRig();
    void service.ask({
      prompt: 'Two decisions:',
      questions: [
        { prompt: 'Version', options: ['bump', 'keep'] },
        { prompt: 'Install', options: ['open', 'skip'] },
      ],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    const text = channel.sent[0]?.text ?? '';
    expect(text).toContain('1) Version');
    expect(text).toContain('2) Install');
    expect(text).toContain('   1. bump');
    expect(text).toContain('one number per question');
    // Plain-text channels retain a free-text route alongside numbered choices.
    expect(text).toContain('or send free text instead');
  });

  it('labels each Telegram step with its position and prompt', async () => {
    const { bridge, channel, service } = bridgeRig({ channelName: 'telegram' });
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    void service.ask({
      prompt: 'Version',
      questions: [
        { prompt: 'Version', options: ['bump', 'keep'] },
        { prompt: 'Install', options: ['open', 'skip'] },
      ],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.inlineKeyboards).toHaveLength(1));
    const first = channel.inlineKeyboards[0]?.text ?? '';
    expect(first).toContain('Forge asks (1/2) · Version');
    expect(first).toContain('Choose one');

    const questionId = asked.mock.calls[0]?.[0].id as string;
    await bridge.handleAction(questionAction(questionId, 'select', 'keyboard-1', 1));
    await bridge.handleAction(questionAction(questionId, 'next', 'keyboard-1'));
    await vi.waitFor(() => expect(channel.inlineKeyboards).toHaveLength(2));
    expect(channel.inlineKeyboards[1]?.text).toContain('Forge asks (2/2) · Install');
  });

  it('asks Telegram sub-questions one keyboard at a time and settles with labelled lines', async () => {
    const { bridge, channel, service } = bridgeRig({ channelName: 'telegram' });
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({
      prompt: 'Two decisions:',
      questions: [
        { prompt: 'Version', options: ['bump', 'keep'] },
        { prompt: 'Install', options: ['open', 'skip'] },
        { prompt: 'Notes', options: ['short', 'long'] },
      ],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.inlineKeyboards).toHaveLength(1));
    const questionId = asked.mock.calls[0]?.[0].id as string;
    expect(channel.inlineKeyboards[0]?.text).toContain('Forge asks (1/3) · Version');
    expect(channel.inlineKeyboards[0]?.buttons.flat().map((b) => b.text)).toEqual([
      'bump',
      'keep',
      'Note…',
      'Skip',
      'Next ›',
    ]);

    await expect(
      bridge.handleAction(questionAction(questionId, 'select', 'keyboard-1', 2)),
    ).resolves.toEqual({ kind: 'handled' });
    await bridge.handleAction(questionAction(questionId, 'next', 'keyboard-1'));
    expect(channel.inlineKeyboards).toHaveLength(2);
    expect(channel.inlineKeyboards[1]?.text).toContain('Forge asks (2/3) · Install');
    // The first keyboard is gone, so a second tap on it is stale, not step 2's answer.
    await expect(
      bridge.handleAction(questionAction(questionId, 'select', 'keyboard-1', 1)),
    ).resolves.toEqual({ kind: 'rejected', reason: 'question button is stale' });

    // Typed text answers the step on screen; a bare number picks its option.
    expect(bridge.answerText('chat-1', '2')).toBe(true);
    await vi.waitFor(() => expect(channel.inlineKeyboardReplacements).toHaveLength(1));
    await bridge.handleAction(questionAction(questionId, 'next', 'keyboard-2'));
    expect(channel.inlineKeyboards).toHaveLength(3);
    expect(channel.inlineKeyboards[2]?.text).toContain('Forge asks (3/3) · Notes');

    await expect(
      bridge.handleAction(questionAction(questionId, 'note', 'keyboard-3')),
    ).resolves.toEqual({ kind: 'handled' });
    expect(channel.sent.at(-1)?.text).toContain('Send your note');
    expect(bridge.answerText('chat-1', 'just a line')).toBe(true);
    await vi.waitFor(() => expect(channel.inlineKeyboardReplacements).toHaveLength(2));
    await bridge.handleAction(questionAction(questionId, 'next', 'keyboard-3'));
    await expect(pending).resolves.toBe('Version: keep\nInstall: skip\nNotes: just a line');
    expect(bridge.hasPending('chat-1')).toBe(false);
  });

  it('holds back prose sent while a step keyboard waits, instead of answering with it', async () => {
    // A follow-up "Have you received my reply?" once became the Plan C answer.
    const { bridge, channel, service } = bridgeRig({ channelName: 'telegram' });
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({
      prompt: 'Two decisions:',
      questions: [
        { prompt: 'Template', options: ['poses', 'buildings'] },
        { prompt: 'Plan C', options: ['approve', 'hold'] },
      ],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.inlineKeyboards).toHaveLength(1));
    const questionId = asked.mock.calls[0]?.[0].id as string;
    await bridge.handleAction(questionAction(questionId, 'note', 'keyboard-1'));
    expect(bridge.answerText('chat-1', 'build both, then implement')).toBe(true);
    await vi.waitFor(() => expect(channel.inlineKeyboardReplacements).toHaveLength(1));
    await bridge.handleAction(questionAction(questionId, 'next', 'keyboard-1'));
    await vi.waitFor(() => expect(channel.inlineKeyboards).toHaveLength(2));

    expect(bridge.answerText('chat-1', 'Have you received my reply?')).toBe(true);
    await vi.waitFor(() =>
      expect(channel.sent.at(-1)?.text).toContain('waiting on question 2 of 2'),
    );
    expect(service.hasPending('c1')).toBe(true);
    expect(bridge.answerText('chat-1', '7')).toBe(true);
    expect(service.hasPending('c1')).toBe(true);

    expect(bridge.answerText('chat-1', '1')).toBe(true);
    await vi.waitFor(() => expect(channel.inlineKeyboardReplacements).toHaveLength(2));
    await bridge.handleAction(questionAction(questionId, 'next', 'keyboard-2'));
    await expect(pending).resolves.toBe('Template: build both, then implement\nPlan C: approve');
  });

  it('passes free text through verbatim when a sub-question is answered in prose', async () => {
    const { bridge, service } = bridgeRig();
    const pending = service.ask({
      prompt: 'Two decisions:',
      questions: [
        { prompt: 'Version', options: ['bump', 'keep'] },
        { prompt: 'Install', options: ['open', 'skip'] },
      ],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(bridge.hasPending('chat-1')).toBe(true));

    // Not an index pair, so it is not coerced into a labelled group answer.
    expect(bridge.answerText('chat-1', 'bump it but do not install')).toBe(true);
    await expect(pending).resolves.toBe('bump it but do not install');
  });

  it('stays silent for a turn with neither a remote chain nor a bound chat', async () => {
    const { bridge, channel, service } = bridgeRig({ remoteRequestId: undefined });
    void service.ask({ prompt: 'Which file?', conversationId: 'c1' });
    // No target: the bridge decides synchronously and never asks the session.
    await new Promise((resolve) => setImmediate(resolve));
    expect(channel.sent).toHaveLength(0);
    expect(bridge.hasPending('chat-1')).toBe(false);
  });

  it('asks the bound chat when the turn was started in the sidebar', async () => {
    const { bridge, channel, service } = bridgeRig({
      remoteRequestId: undefined,
      boundChatId: 'chat-9',
    });
    const pending = service.ask({ prompt: 'Which file?', conversationId: 'c1' });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.chatId).toBe('chat-9');
    expect(bridge.answerText('chat-9', 'src/index.ts')).toBe(true);
    await expect(pending).resolves.toBe('src/index.ts');
  });

  it('never hands the question to an expired session', async () => {
    const { channel, service, deliveryDecided } = bridgeRig({ canDeliver: false });
    void service.ask({ prompt: 'TOP SECRET question', conversationId: 'c1' });
    await deliveryDecided(1);
    expect(channel.sent).toHaveLength(0);
  });

  it('shows a question asked while locked once the chat authenticates, and only once', async () => {
    const options = { canDeliver: false };
    const { bridge, channel, service, deliveryDecided } = bridgeRig(options);
    void service.ask({ prompt: 'Asked before unlock', conversationId: 'c1' });
    await deliveryDecided(1);
    expect(channel.sent).toHaveLength(0);
    options.canDeliver = true;
    bridge.republish('someone-else');
    bridge.republish('chat-1');
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.text).toContain('Forge asks: Asked before unlock');
    bridge.republish('chat-1');
    // A delivered question is not republished, so no further send can follow.
    await new Promise((resolve) => setImmediate(resolve));
    expect(channel.sent).toHaveLength(1);
  });

  it('clears the "answered" receipt after the reply delay but keeps a dismissal', async () => {
    for (const answered of [true, false]) {
      const armEphemeral = vi.fn();
      const cleanup = { armEphemeral } as unknown as CommandCleanupScheduler;
      const { channel, service } = bridgeRig({ cleanup });
      let id = '';
      service.addSink({ asked: (event) => (id = event.id), answered: () => undefined });
      const pending = service.ask({ prompt: 'Which file?', conversationId: 'c1' });
      await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
      if (answered) service.answer(id, 'a.ts');
      else service.dismiss(id);
      await pending;
      await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
      if (answered) expect(armEphemeral).toHaveBeenCalledWith('chat-1', expect.any(Array));
      else expect(armEphemeral).not.toHaveBeenCalled();
    }
  });

  it('reports no pending question for an unknown chat', () => {
    const { bridge } = bridgeRig();
    expect(bridge.answerText('someone-else', 'hello')).toBe(false);
  });
});

