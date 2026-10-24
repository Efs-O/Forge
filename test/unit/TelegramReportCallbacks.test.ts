import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { handleRemoteCommand } from '../../src/remote/RemoteCommandHandler';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import { handleRemoteSessionCommand } from '../../src/remote/RemoteSessionCommands';
import { handleRemoteReportCallback } from '../../src/remote/RemoteReportCallbacks';
import { RemoteAgentAsk, parseTelegramAgentAskCallback } from '../../src/remote/remoteAgentAsk';
import { parseTelegramCommandCallback, telegramCommandButton } from '../../src/remote/TelegramCommandButtons';
import { parseTelegramHelpCallback, telegramHelpSectionButton } from '../../src/remote/TelegramHelpButtons';
import { parseTelegramJobCallback, telegramJobCallback, telegramJobHash } from '../../src/remote/TelegramJobButtons';
import { parseTelegramQueueCallback, telegramQueueCallback } from '../../src/remote/TelegramQueueButtons';
import { parseTelegramQuestionCallback } from '../../src/remote/TelegramQuestionButtons';
import { parseTelegramSendNowCallback } from '../../src/remote/TelegramSendNowButton';
import {
  parseTelegramSelectionCallback,
  telegramSelectionKeyboard,
} from '../../src/remote/TelegramSelectionPagination';
import { isTelegramStopCallback } from '../../src/remote/TelegramStopButton';
import { mapTelegramCallbackQuery } from '../../src/remote/telegramCallbackMapping';
import type { RemoteInboundEvent, RemoteInboundDisposition } from '../../src/remote/types';
import type { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { RemoteSessionAuth } from '../../src/remote/RemoteSessionAuth';
import { generateTotp } from '../../src/remote/RemoteTotp';
import { MemorySecrets } from '../support/memorySecrets';
import { telegramChatType } from '../../src/remote/TelegramInboundMapping';
describe('Telegram callback families and report actions', () => {
  const base = {
    channel: 'telegram' as const,
    providerMessageId: 'callback-id',
    senderId: '7',
    chatId: '9',
    chatType: 'private' as const,
    receivedAt: 1,
    messageId: '42',
  };

  function map(data: string): RemoteInboundEvent | undefined {
    return mapTelegramCallbackQuery({
      id: base.providerMessageId,
      data,
      from: { id: 7 },
      message: { message_id: 42, chat: { id: 9, type: 'private' } },
    }, telegramChatType);
  }

  it('keeps callback prefixes disjoint, including q: questions versus queue actions', () => {
    expect(parseTelegramSelectionCallback('s:abcdefghijkl:c:n7')?.action).toBe('pick');
    expect(parseTelegramHelpCallback('h:s:session')).toEqual({ action: 'section', sectionKey: 'session' });
    expect(parseTelegramCommandCallback('k:status')?.text).toBe('/status');
    expect(parseTelegramCommandCallback('k:system')?.text).toBe('/system');
    expect(parseTelegramCommandCallback('k:chatSolo')?.text).toBe('/chatmode solo');
    expect(parseTelegramCommandCallback('k:chatMulti')?.text).toBe('/chatmode multi');
    expect(parseTelegramJobCallback('j:0:deadbeef:r')?.action).toBe('r');
    expect(parseTelegramQueueCallback('q:request-1')).toEqual({ kind: 'one', requestId: 'request-1' });
    expect(parseTelegramQueueCallback('q:question-id:1')).toBeUndefined();
    expect(parseTelegramQuestionCallback('q:question-id:1')).toEqual({
      questionId: 'question-id',
      action: 'select',
      choice: 1,
    });
    expect(parseTelegramQuestionCallback('q:request-1')).toBeUndefined();
    expect(parseTelegramAgentAskCallback('a:claude')).toBe('claude');
    expect(parseTelegramAgentAskCallback(`a:${'A'.repeat(24)}`)).toBeUndefined();
    expect(parseTelegramJobCallback('a:claude')).toBeUndefined();
    expect(parseTelegramSendNowCallback(`n:123e4567-e89b-12d3-a456-426614174000`)).toBe(
      '123e4567-e89b-12d3-a456-426614174000',
    );

    const expected: Array<[string, RemoteInboundEvent['kind']]> = [
      ['s:abcdefghijkl:c:n7', 'selection'],
      ['h:s:session', 'help_action'],
      ['k:status', 'text'],
      ['k:chatSolo', 'text'],
      ['k:chatMulti', 'text'],
      ['j:0:deadbeef:r', 'job_action'],
      ['q:request-1', 'queue_action'],
      ['a:claude', 'agent_ask_action'],
      ['n:123e4567-e89b-12d3-a456-426614174000', 'send_now_action'],
      ['q:question-id:1', 'question_action'],
      ['x', 'stop_action'],
      ['y', 'stop_action'],
      [`a:${'A'.repeat(24)}`, 'action'],
    ];
    for (const [data, kind] of expected) expect(map(data)?.kind, data).toBe(kind);
    const parserFamilies: Array<[string, (data: string) => boolean]> = [
      ['selection', (data) => parseTelegramSelectionCallback(data) !== undefined],
      ['help', (data) => parseTelegramHelpCallback(data) !== undefined],
      ['command', (data) => parseTelegramCommandCallback(data) !== undefined],
      ['job', (data) => parseTelegramJobCallback(data) !== undefined],
      ['queue', (data) => parseTelegramQueueCallback(data) !== undefined],
      ['agent ask', (data) => parseTelegramAgentAskCallback(data) !== undefined],
      ['send now', (data) => parseTelegramSendNowCallback(data) !== undefined],
      ['question', (data) => parseTelegramQuestionCallback(data) !== undefined],
      ['stop', isTelegramStopCallback],
    ];
    const familyCases: Array<[string, string]> = [
      ['s:abcdefghijkl:c:n7', 'selection'],
      ['h:s:session', 'help'],
      ['k:status', 'command'],
      ['j:0:deadbeef:r', 'job'],
      ['q:request-1', 'queue'],
      ['q:question-id:1', 'question'],
      ['a:claude', 'agent ask'],
      ['n:123e4567-e89b-12d3-a456-426614174000', 'send now'],
      ['x', 'stop'],
      [`a:${'A'.repeat(24)}`, 'approval'],
    ];
    for (const [data, expectedFamily] of familyCases) {
      const matches = parserFamilies
        .filter(([, accepts]) => accepts(data))
        .map(([family]) => family);
      expect(matches, data).toEqual(expectedFamily === 'approval' ? [] : [expectedFamily]);
      expect(map(data), data).toBeDefined();
    }
    expect(map('k:status')).toMatchObject({
      kind: 'text',
      text: '/status',
      callbackMessageId: '42',
    });
    expect(map('k:chatMulti')).toMatchObject({
      kind: 'text',
      text: '/chatmode multi',
      callbackMessageId: '42',
    });
    expect(map('k:delete')).toBeUndefined();
  });

  it('keeps new callback data under 64 bytes and rejects overlong queue ids', () => {
    const selection = telegramSelectionKeyboard({
      kind: 'workspaces',
      token: 'abcdefghijkl',
      page: 0,
      pageCount: 1,
      pickIndexes: [999],
    }).inline_keyboard[0]![0]!.callback_data;
    const data = [
      telegramCommandButton('context', 'Context').callbackData,
      telegramCommandButton('chatSolo', 'Solo').callbackData,
      telegramCommandButton('chatMulti', 'Multi').callbackData,
      telegramHelpSectionButton('12345678', 'Long key').callbackData,
      telegramJobCallback(99_999_999, 'job-id', 'D'),
      telegramQueueCallback('x'.repeat(60)),
      selection,
    ];
    expect(data.every((item) => Buffer.byteLength(item, 'utf8') <= 64)).toBe(true);
    expect(parseTelegramCommandCallback(data[0]!)).toBeDefined();
    expect(parseTelegramCommandCallback(data[1]!)).toBeDefined();
    expect(parseTelegramCommandCallback(data[2]!)).toBeDefined();
    expect(parseTelegramHelpCallback(data[3]!)).toBeDefined();
    expect(parseTelegramJobCallback(data[4]!)).toBeDefined();
    expect(parseTelegramQueueCallback(data[5]!)).toBeDefined();
    expect(parseTelegramSelectionCallback(data[6]!)?.index).toBe(999);
    expect(() => telegramQueueCallback('x'.repeat(61))).toThrow('request id is invalid');
  });

  it('renders queue and linked-agent cards with escaped values and typed buttons', async () => {
    const channel = new FakeRemoteChannel('telegram');
    channel.declareHtmlSupport();
    const commandEvent = {
      channel: 'telegram',
      kind: 'text',
      providerMessageId: 'typed',
      senderId: '7',
      chatId: '9',
      chatType: 'private',
      receivedAt: 1,
      text: '/queue',
    } as Extract<RemoteInboundEvent, { kind: 'text' }>;
    const context = {
      channel,
      signal: new AbortController().signal,
      store: {
        binding: () => ({ conversationId: 'c1' }),
        queued: () => [
          {
            id: 'req-1',
            channel: 'telegram',
            chatId: '9',
            conversationId: 'c1',
            text: '<prompt & detail>',
            priority: 'steer',
            attachments: [],
          },
        ],
      },
      host: {
        getAgentLink: (_conversationId: string, kind: string) =>
          kind === 'claude' ? { title: 'Claude <session>', lastUsedAt: Date.now() } : undefined,
      },
    } as unknown as RemoteCommandContext;

    await handleRemoteSessionCommand('/queue', undefined, commandEvent, context);
    expect(channel.inlineKeyboards[0]?.text).toContain('&lt;prompt &amp; detail&gt;');
    expect(channel.inlineKeyboards[0]?.buttons.flat()[0]?.callbackData).toBe('q:req-1');

    await handleRemoteSessionCommand('/agents', undefined, commandEvent, context);
    expect(channel.inlineKeyboards[1]?.text).toContain('Claude &lt;session&gt;');
    expect(channel.inlineKeyboards[1]?.text).toContain('<b>Codex</b> · not linked');
    expect(channel.inlineKeyboards[1]?.buttons[0]?.map((button) => button.callbackData)).toEqual([
      'a:claude',
      'a:codex',
      'a:copilot',
    ]);
  });

  it('routes a picker tap into the matching typed command path', async () => {
    const channel = new FakeRemoteChannel('telegram');
    const setConversationModel = vi.fn(async () => undefined);
    const commandStore = {
      beginControlEvent: async () => 'admitted',
      finishControlEvent: async () => undefined,
      discardControlEvent: async () => undefined,
      binding: () => ({ conversationId: 'c1', workspaceId: 'workspace' }),
      queued: () => [],
      selection: () => ({ values: ['one', 'two'] }),
    };
    const commandContext = {
      channel,
      store: commandStore,
      host: {
        status: () => ({
          conversations: [
            { id: 'c1', title: 'Chat', activeModel: 'one', archived: false, updatedAt: 1 },
          ],
          requestChains: [],
          streamingConversationIds: [],
        }),
        setConversationModel,
      },
      workspaceId: 'workspace',
      signal: new AbortController().signal,
      inactivityTimeoutMinutes: 30,
      rateLimitPerMinute: 30,
      modelEntries: [
        { name: 'one', group: 'Local — llama.cpp' },
        { name: 'two', group: 'Local — llama.cpp' },
      ],
      workspaceAliases: {},
    } as unknown as RemoteCommandContext;
    const routeText = vi.fn(
      async (
        event: Extract<RemoteInboundEvent, { kind: 'text' }>,
        overrides?: object,
      ): Promise<RemoteInboundDisposition> =>
        handleRemoteCommand(event, { ...commandContext, ...overrides }, event.providerMessageId),
    );
    const deps = {
      channel,
      store: commandStore as unknown as RemoteRequestStore,
      agentAsk: new RemoteAgentAsk(),
      commandContext: () => commandContext,
      routeText,
    };
    await handleRemoteCommand(
      { ...base, kind: 'text', providerMessageId: 'typed-command', text: '/model 2' },
      commandContext,
      'typed-command',
    );
    const result = await handleRemoteReportCallback(
      {
        ...base,
        kind: 'selection',
        selectionKind: 'models',
        selectionToken: 'abcdefghijkl',
        action: 'pick',
        index: 1,
      },
      deps,
    );
    expect(result).toEqual({ kind: 'handled' });
    expect(routeText.mock.calls[0]?.[0].text).toBe('/model 2');
    expect(routeText.mock.calls[0]?.[0].callbackMessageId).toBe('42');
    expect(setConversationModel.mock.calls.map(([conversationId, model]) => [conversationId, model])).toEqual([
      ['c1', 'two'],
      ['c1', 'two'],
    ]);
  });

  it('rejects an expired picker and marks stale job actions without routing them', async () => {
    const channel = new FakeRemoteChannel('telegram');
    const routeText = vi.fn(async (): Promise<RemoteInboundDisposition> => ({ kind: 'handled' }));
    const deps = {
      channel,
      store: { selection: () => undefined } as unknown as RemoteRequestStore,
      agentAsk: new RemoteAgentAsk(),
      commandContext: () => ({
        jobs: { enabled: true, store: { loadAll: async () => [{ job: { id: 'disk' } }] } },
      }) as unknown as RemoteCommandContext,
      routeText,
    };
    const expired = await handleRemoteReportCallback(
      {
        ...base,
        kind: 'selection',
        selectionKind: 'conversations',
        selectionToken: 'abcdefghijkl',
        action: 'pick',
        index: 0,
      },
      deps,
    );
    expect(expired).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('list expired') });

    await handleRemoteReportCallback(
      { ...base, kind: 'job_action', index: 0, hash: '00000000', action: 'r' },
      deps,
    );
    expect(channel.sent.at(-1)?.text).toContain('The job list changed');
    expect(routeText).not.toHaveBeenCalled();
  });

  it('maps every job card action to the existing /job command', async () => {
    const channel = new FakeRemoteChannel('telegram');
    const file = { job: { id: 'disk' } };
    const routeText = vi.fn(async (): Promise<RemoteInboundDisposition> => ({ kind: 'handled' }));
    const deps = {
      channel,
      store: {} as RemoteRequestStore,
      agentAsk: new RemoteAgentAsk(),
      commandContext: () => ({
        jobs: { enabled: true, store: { loadAll: async () => [file] } },
      }) as unknown as RemoteCommandContext,
      routeText,
    };
    const cases = [
      ['r', '/job 1 run'],
      ['p', '/job 1 pause'],
      ['u', '/job 1 resume'],
      ['c', '/job 1 chat'],
      ['d', '/job 1 delete'],
      ['D', '/job 1 delete confirm'],
    ] as const;
    for (const [action, command] of cases) {
      await handleRemoteReportCallback(
        {
          ...base,
          kind: 'job_action',
          index: 0,
          hash: telegramJobHash('disk'),
          action,
        },
        deps,
      );
      expect(routeText.mock.calls.at(-1)?.[0].text).toBe(command);
      expect(routeText.mock.calls.at(-1)?.[1]).toMatchObject({
        telegramEditMessageId: '42',
        telegramJobTarget: { index: 0, hash: telegramJobHash('disk'), action },
      });
    }
  });

  it('sends queue buttons through /drop and agent asks through a ten-minute reply rendezvous', async () => {
    const channel = new FakeRemoteChannel('telegram');
    const routeText = vi.fn(async (): Promise<RemoteInboundDisposition> => ({ kind: 'handled' }));
    const asks = new RemoteAgentAsk();
    const deps = {
      channel,
      store: {} as RemoteRequestStore,
      agentAsk: asks,
      commandContext: () => ({} as RemoteCommandContext),
      routeText,
    };
    await handleRemoteReportCallback(
      { ...base, kind: 'queue_action', requestId: 'req-1' },
      deps,
    );
    expect(routeText.mock.calls[0]?.[0].text).toBe('/drop req-1');
    expect(routeText.mock.calls[0]?.[1]).toEqual({ telegramEditMessageId: '42' });
    await handleRemoteReportCallback({ ...base, kind: 'queue_action', all: true }, deps);
    expect(routeText.mock.calls[1]?.[0].text).toBe('/drop all');

    await handleRemoteReportCallback({ ...base, kind: 'agent_ask_action', agentKind: 'claude' }, deps);
    expect(channel.forceReplies[0]).toEqual({
      chatId: '9',
      text: 'Question for Claude:',
      placeholder: 'Ask Claude…',
    });
    const reply = {
      ...base,
      kind: 'text' as const,
      text: 'review this change',
      replyToMessageId: 'force-1',
      providerMessageId: 'reply-1',
    };
    const redirected = asks.consume(reply);
    expect(redirected?.text).toBe('/claude review this change');
    await deps.routeText(redirected!);
    expect(routeText.mock.calls.at(-1)?.[0].text).toBe('/claude review this change');
    asks.remember('9', 'force-2', 'codex', 0);
    asks.remember('9', 'force-3', 'copilot', 0);
    expect(asks.consume({ ...reply, replyToMessageId: 'force-2' }, 1)).toBeUndefined();
    expect(asks.consume({ ...reply, replyToMessageId: 'force-3' }, 1)?.text).toBe(
      '/copilot review this change',
    );
    asks.remember('9', 'force-4', 'codex', 0);
    expect(asks.consume({ ...reply, replyToMessageId: 'force-4' }, 600_000)).toBeUndefined();
    asks.dispose();
  });

  it('runs queue drops through /drop and reports an already-gone request id', async () => {
    const channel = new FakeRemoteChannel('telegram');
    const queue = [
      {
        id: 'req-1',
        channel: 'telegram',
        chatId: '9',
        conversationId: 'c1',
        text: 'prompt',
        priority: 'normal',
        attachments: [],
      },
    ];
    const cancelQueued = vi.fn(async (_conversationId: string, ids: ReadonlySet<string>) => {
      const before = queue.length;
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (ids.has(queue[index]!.id)) queue.splice(index, 1);
      }
      return before - queue.length;
    });
    const context = {
      channel,
      store: {
        beginControlEvent: async () => 'admitted',
        finishControlEvent: async () => undefined,
        discardControlEvent: async () => undefined,
        binding: () => ({ conversationId: 'c1', workspaceId: 'workspace' }),
        queued: () => queue,
        cancelQueued,
        getRequest: () => undefined,
      },
      host: {},
      workspaceId: 'workspace',
      signal: new AbortController().signal,
      inactivityTimeoutMinutes: 30,
      rateLimitPerMinute: 30,
      modelEntries: [],
      workspaceAliases: {},
    } as unknown as RemoteCommandContext;
    const routeText = async (
      event: Extract<RemoteInboundEvent, { kind: 'text' }>,
      overrides?: object,
    ): Promise<RemoteInboundDisposition> =>
      handleRemoteCommand(event, { ...context, ...overrides }, event.providerMessageId);
    const deps = {
      channel,
      store: {} as RemoteRequestStore,
      agentAsk: new RemoteAgentAsk(),
      commandContext: () => context,
      routeText,
    };

    await handleRemoteReportCallback(
      { ...base, kind: 'queue_action', requestId: 'req-1' },
      deps,
    );
    expect(cancelQueued).toHaveBeenCalledWith('c1', new Set(['req-1']));
    expect(channel.inlineEdits.at(-1)?.text).toContain('Nothing queued.');

    await handleRemoteReportCallback(
      { ...base, providerMessageId: 'callback-again', kind: 'queue_action', requestId: 'req-1' },
      deps,
    );
    expect(cancelQueued).toHaveBeenCalledTimes(1);
    expect(channel.sent.at(-1)?.text).toBe('Already gone.');
    expect(channel.inlineEdits.at(-1)?.text).toContain('Nothing queued.');
  });

  it('maps command buttons to text events that pass the authenticated session gate', async () => {
    const secrets = new MemorySecrets();
    const auth = new RemoteSessionAuth(
      secrets as unknown as vscode.SecretStorage,
      { inactivityTimeoutMinutes: 30 },
    );
    const now = 1_234_567_890_000;
    const secret = auth.createEnrollmentSecret();
    await auth.confirmEnrollment('telegram', '7', secret, generateTotp(secret, now).code, now);
    const command = map('k:status');
    expect(command).toMatchObject({ kind: 'text', text: '/status' });
    if (!command) throw new Error('command button was not mapped');
    expect(await auth.gate(command, '7', now)).toEqual({ kind: 'challenge', reason: 'locked' });
    const code = {
      ...base,
      kind: 'text' as const,
      providerMessageId: 'auth-code',
      receivedAt: now,
      text: generateTotp(secret, now).code,
    };
    expect(await auth.gate(code, '7', now)).toMatchObject({ kind: 'authorized' });
    expect(await auth.gate(command, '7', now + 1)).toMatchObject({ kind: 'authorized' });
    expect(map('k:unknown')).toBeUndefined();
    expect(isTelegramStopCallback('x')).toBe(true);
  });
});
