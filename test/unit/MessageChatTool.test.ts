import { describe, expect, it, vi } from 'vitest';
import type {
  ForgeConversationSummary,
  ForgeHostFacade,
  ForgeHostStatus,
} from '../../src/sidebar/ForgeHostFacade';
import type { ChatMessageDelivery } from '../../src/sidebar/backgroundExitNotice';
import { makeMessageChatTool, type MessageChatSidebar } from '../../src/tools/messageChatTool';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';
import type { ForgeConfig } from '../../src/config/types';

function conversation(
  id: string,
  title: string,
  activeModel: string | null = 'strata-flash',
  archived = false,
): ForgeConversationSummary {
  return {
    id,
    title,
    activeModel,
    archived,
    updatedAt: 0,
    requestCount: 0,
    toolCallCount: 0,
    compactCount: 0,
    activeMs: 0,
  };
}

function hostStatus(
  options: {
    activeConversationId?: string;
    running?: string[];
    archived?: boolean;
  } = {},
): ForgeHostStatus {
  return {
    activeConversationId: options.activeConversationId ?? 'sender',
    conversations: [
      conversation('sender', 'Sender'),
      conversation('running', 'Bug hunt'),
      conversation('idle', 'Release notes', null),
      ...(options.archived ? [conversation('archived', 'Old notes', null, true)] : []),
    ],
    requestChains: [],
    streamingConversationIds: options.running ?? [],
  };
}

type DeliverMock = ReturnType<
  typeof vi.fn<(text: string, id: string, steer?: boolean) => Promise<ChatMessageDelivery>>
>;

/** Mirrors the router: a busy (streaming or reserved) chat takes a tell, an idle one a turn. */
function makeSidebar(status: ForgeHostStatus): MessageChatSidebar & {
  deliverChatMessage: DeliverMock;
  emitHostActivity: ReturnType<typeof vi.fn>;
} {
  const emitHostActivity = vi.fn();
  const createConversation = vi.fn(async () => conversation('new-chat', 'Untitled chat'));
  const setConversationModel = vi.fn(async (_id: string, _model: string | null) => {});
  const applyAutoTitle = vi.fn(() => false);
  const recentExchanges = vi.fn((_id: string, _limit: number) => []);
  return {
    getHostFacade: () => ({
      status: () => status,
      emitHostActivity,
      chatCapBlockers: vi.fn(() => []),
      createConversation,
      setConversationModel,
      applyAutoTitle,
      recentExchanges,
      clankerMode: () => false,
    }),
    emitHostActivity,
    createConversation,
    setConversationModel,
    applyAutoTitle,
    recentExchanges,
    deliverChatMessage: vi.fn((_text: string, id: string, _steer?: boolean) =>
      Promise.resolve<ChatMessageDelivery>(
        status.streamingConversationIds.includes(id) ||
          status.requestChains.some((chain) => chain.conversationId === id)
          ? { kind: 'tell' }
          : { kind: 'turn' },
      ),
    ),
  };
}

function context(conversationId = 'sender'): ToolHandlerContext {
  return { beforeMutate: vi.fn(), conversationId };
}

function makeTool(status = hostStatus(), now?: () => number) {
  const sidebar = makeSidebar(status);
  const tool = makeMessageChatTool({ getSidebar: () => sidebar, ...(now ? { now } : {}) });
  return { tool, sidebar };
}

describe('message_chat tool contract and handler', () => {
  it('advertises the exact strict schema and rejects extra keys', async () => {
    const { tool } = makeTool();
    expect(tool.definition.function.parameters).toEqual({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'send', 'view'] },
        to: { type: 'string', minLength: 1, maxLength: 200 },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 12000,
          description:
            "Write it as you would to a coworker: first person, call the other chat 'you', no formalities, no reports about yourself in the third person. At most 12,000 characters; send a longer message in parts.",
        },
      },
      required: [],
      additionalProperties: false,
    });
    // `action` is no longer required, and the description says what replaces it,
    // so the model is not asked to guess why a message-only call worked.
    expect(
      (tool.definition.function as { description: string }).description,
    ).toContain('`action` defaults to `send` when a `message` is given');
    await expect(tool.handler({ action: 'list', extra: true }, context())).rejects.toThrow();
  });

  it('refuses an oversize message by counting its parts, not by saying shorten it', async () => {
    const { tool, sidebar } = makeTool(hostStatus({ running: ['running'] }));
    const message = 'x'.repeat(12_500);
    await expect(
      tool.handler({ action: 'send', to: 'running', message }, context()),
    ).rejects.toThrow(
      'message_chat message is 12500 characters; the limit is 12000. Send it as 2 messages.',
    );
    // Refused before anything was routed, so a refused retry costs nothing.
    expect(sidebar.deliverChatMessage).not.toHaveBeenCalled();
  });

  it('accepts a message the old 4,000 cap refused', async () => {
    const { tool, sidebar } = makeTool(hostStatus({ running: ['running'] }));
    const message = 'x'.repeat(11_000);
    expect(message.length).toBeGreaterThan(4000);
    const result = String(
      await tool.handler({ action: 'send', to: 'running', message }, context()),
    );
    expect(result).toContain('Delivered to #2 "Bug hunt" (running)');
    expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(1);
  });

  it('a message with no action is delivered as send, and the result says so', async () => {
    const { tool, sidebar } = makeTool(hostStatus({ running: ['running'] }));
    const result = String(await tool.handler({ to: '#2', message: 'Lane 5 here.' }, context()));
    expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(1);
    expect(sidebar.createConversation).not.toHaveBeenCalled();
    expect(result).toContain('Delivered to #2 "Bug hunt" (running)');
    expect(result).toContain('No `action` was given, so `send` was used.');
  });

  it('a message with no action still counts against the send caps', async () => {
    // The inference must not be a way to send more than the tool allows: an
    // inferred send is recorded in the window exactly as an explicit one, so the
    // sixth idle wake is the last one and the seventh is refused.
    const { tool } = makeTool();
    const results: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      results.push(String(await tool.handler({ to: 'idle', message: `wake ${index + 1}` }, context())));
    }
    expect(results.slice(0, 6).every((result) => result.includes('a turn started there'))).toBe(true);
    expect(results[6]).toContain('idle-chat-wake-per-hour limit');
    expect(results[6]).toContain('No `action` was given, so `send` was used.');
  });

  it('a call with neither action nor message is refused, naming the actions', async () => {
    const { tool, sidebar } = makeTool();
    // Thrown, as the missing-`action` ZodError was before: `ToolDispatch` prefixes
    // `Error:` and counts the failure, so the streak that can strip a model's
    // tools still sees this call as one.
    let refusal = '';
    try {
      await tool.handler({}, context());
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain('message_chat needs `action`');
    expect(refusal).toContain('(one of: list, send, view)');
    expect(sidebar.deliverChatMessage).not.toHaveBeenCalled();
    expect(sidebar.createConversation).not.toHaveBeenCalled();
  });

  it('never infers new or steer, even when both are enabled', async () => {
    const status = hostStatus({ running: ['running'] });
    const sidebar = makeSidebar(status);
    const config = {
      permissions: { chats: { new_chat: true, steer: true } },
    } as ForgeConfig;
    const tool = makeMessageChatTool({ getSidebar: () => sidebar, getConfig: () => config });
    // The advertised enum now offers four actions; a bare message still goes to
    // the send path, because `new` would create a chat and `steer` would
    // interrupt one, and neither is what a message-only call asked for.
    const described = tool.describe!();
    const advertisedActions = (
      described.function.parameters.properties as { action: { enum: string[] } }
    ).action.enum;
    expect(advertisedActions).toEqual(['list', 'send', 'view', 'new', 'steer']);
    const result = String(await tool.handler({ to: '#2', message: 'Lane 5 here.' }, context()));
    expect(sidebar.createConversation).not.toHaveBeenCalled();
    expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(1);
    expect(result).toContain('Delivered to #2');
    expect(result).toContain('No `action` was given, so `send` was used.');
    // An explicit `new` is still `new`: the inference did not swallow the action
    // that creates a chat, and its result does not claim it was inferred.
    const created = String(await tool.handler({ action: 'new', message: 'hi' }, context()));
    expect(sidebar.createConversation).toHaveBeenCalledTimes(1);
    expect(created).not.toContain('No `action` was given');
  });

  it('lists open chats in tab order, marks the caller and rejects ignored fields', async () => {
    const { tool } = makeTool(hostStatus({ archived: true }));
    const result = await tool.handler({ action: 'list' }, context());
    expect(result).toContain('Chats in this window (you are #1):');
    expect(result).toContain('#1 · Sender · idle · strata-flash · id sender ← you');
    expect(result).toContain('#2 · Bug hunt · idle · strata-flash · id running');
    expect(result).toContain('#3 · Release notes · idle · id idle');
    expect(result).not.toContain('Old notes');
    expect(result.indexOf('#1 · Sender')).toBeLessThan(result.indexOf('#2 · Bug hunt'));
    const refused = await tool.handler({ action: 'list', message: 'ignored' }, context());
    expect(refused).toContain('does not take `to` or `message`');
    expect(refused).toContain('send:');
    const targetRefused = await tool.handler({ action: 'list', to: '#2' }, context());
    expect(targetRefused).toContain('does not take `to` or `message`');
  });

  it('reads a closed chat with `view` and marks the read closed', async () => {
    const { tool, sidebar } = makeTool(hostStatus({ archived: true }));
    const view = await tool.handler({ action: 'view', to: 'Old notes' }, context());
    expect(view).toContain('View of "Old notes" (id archived, closed):');
    expect(view).toContain('No answers in this chat yet.');
    expect(sidebar.recentExchanges).toHaveBeenCalledWith('archived', 11);
    expect(sidebar.deliverChatMessage).not.toHaveBeenCalled();
    // Reading a closed chat does not reopen it or wake it.
    expect(sidebar.createConversation).not.toHaveBeenCalled();
  });

  it('tells a sender a closed chat is still readable, and never delivers to it', async () => {
    const { tool, sidebar } = makeTool(hostStatus({ archived: true }));
    const result = await tool.handler(
      { action: 'send', to: 'archived', message: 'Report back.' },
      context(),
    );
    expect(result).toContain('No open chat matches');
    expect(result).toContain('That chat is closed; `view` can still read it.');
    expect(sidebar.deliverChatMessage).not.toHaveBeenCalled();
    expect(sidebar.emitHostActivity).not.toHaveBeenCalled();
  });

  it('routes a running-chat message visibly through the router with the sender header', async () => {
    const { tool, sidebar } = makeTool(hostStatus({ running: ['running'] }));
    const result = await tool.handler(
      { action: 'send', to: '#2', message: 'The parser test is ready.' },
      context(),
    );
    expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(1);
    const [delivered, targetId] = sidebar.deliverChatMessage.mock.calls[0] as [string, string];
    expect(targetId).toBe('running');
    expect(delivered).toBe(
      '📨 Message from Sender (id sender):\n' +
        'The parser test is ready.\n\n' +
        '(Reply with message_chat to "sender" if you need to; no need to just acknowledge.)',
    );
    expect(result).toBe(
      'Delivered to #2 "Bug hunt" (running): it reads this at its next tool round.',
    );
  });

  it('routes an idle target by id without changing the active chat', async () => {
    const status = hostStatus();
    const { tool, sidebar } = makeTool(status);
    const result = await tool.handler(
      { action: 'send', to: 'idle', message: 'Please review the release notes.' },
      context(),
    );
    expect(sidebar.deliverChatMessage).toHaveBeenCalledWith(
      expect.stringContaining('📨 Message from Sender (id sender):'),
      'idle',
    );
    expect(status.activeConversationId).toBe('sender');
    expect(result).toBe('Delivered to #3 "Release notes" (idle): a turn started there.');
  });

  it('emits target and sender prompt activity for a tell with the clipped message body', async () => {
    const { tool, sidebar } = makeTool(hostStatus({ running: ['running'] }));
    const body = 'x'.repeat(501);
    await tool.handler({ action: 'send', to: '#2', message: body }, context());
    expect(sidebar.emitHostActivity.mock.calls).toEqual([
      [{ kind: 'prompt', conversationId: 'running', text: `📨 Sender → this chat\n${'x'.repeat(499)}…` }],
      [{ kind: 'prompt', conversationId: 'sender', text: `📤 this chat → Bug hunt  (busy · reads it mid-turn)\n${'x'.repeat(499)}…` }],
    ]);
  });

  it('uses the delivery outcome in the sender activity line', async () => {
    const { tool, sidebar } = makeTool();
    sidebar.deliverChatMessage.mockResolvedValue({ kind: 'turn' });
    await tool.handler({ action: 'send', to: 'idle', message: 'Please review.' }, context());
    expect(sidebar.emitHostActivity.mock.calls).toEqual([
      [{ kind: 'prompt', conversationId: 'idle', text: '📨 Sender → this chat\nPlease review.' }],
      [{ kind: 'prompt', conversationId: 'sender', text: '📤 this chat → Release notes  (idle · started a turn)\nPlease review.' }],
    ]);
  });

  it('uses plain quotes in model-facing result titles and mirror lines', async () => {
    const status = hostStatus({ running: ['running'] });
    status.conversations[0]!.title = 'Sender "one"';
    status.conversations[1]!.title = 'Bug "hunt"';
    const { tool, sidebar } = makeTool(status);
    const result = await tool.handler(
      { action: 'send', to: 'running', message: 'Use plain quotes.' },
      context(),
    );
    const [delivered] = sidebar.deliverChatMessage.mock.calls[0]!;

    expect(result).toBe(
      'Delivered to #2 "Bug \'hunt\'" (running): it reads this at its next tool round.',
    );
    expect(sidebar.emitHostActivity.mock.calls).toEqual([
      [
        {
          kind: 'prompt',
          conversationId: 'running',
          text: '📨 Sender "one" → this chat\nUse plain quotes.',
        },
      ],
      [
        {
          kind: 'prompt',
          conversationId: 'sender',
          text: '📤 this chat → Bug "hunt"  (busy · reads it mid-turn)\nUse plain quotes.',
        },
      ],
    ]);
    const emittedText = sidebar.emitHostActivity.mock.calls.map((call) => call[0].text);
    expect([result, delivered, ...emittedText].some((text) => text.includes('\\\"'))).toBe(false);
  });

  it('does not emit activity for a refused delivery', async () => {
    const { tool, sidebar } = makeTool();
    sidebar.deliverChatMessage.mockResolvedValue({ kind: 'refused', error: 'not available' });
    await tool.handler({ action: 'send', to: 'idle', message: 'hello' }, context());
    expect(sidebar.emitHostActivity).not.toHaveBeenCalled();
  });

  it('emits activity for an unconfirmed delivery timeout', async () => {
    vi.useFakeTimers();
    try {
      const { tool, sidebar } = makeTool();
      sidebar.deliverChatMessage.mockReturnValue(new Promise<ChatMessageDelivery>(() => {}));
      const pending = tool.handler({ action: 'send', to: 'idle', message: 'Please review.' }, context());
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toContain('had not started after 20 s');
      expect(sidebar.emitHostActivity.mock.calls).toEqual([
        [{ kind: 'prompt', conversationId: 'idle', text: '📨 Sender → this chat\nPlease review.' }],
        [{ kind: 'prompt', conversationId: 'sender', text: '📤 this chat → Release notes  (not confirmed yet)\nPlease review.' }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still returns successful delivery text when host activity is absent or throws', async () => {
    const absentSidebar = makeSidebar(hostStatus({ running: ['running'] }));
    absentSidebar.getHostFacade = () => ({ status: () => hostStatus({ running: ['running'] }) });
    const absentTool = makeMessageChatTool({ getSidebar: () => absentSidebar });
    await expect(
      absentTool.handler({ action: 'send', to: 'running', message: 'hello' }, context()),
    ).resolves.toBe('Delivered to #2 "Bug hunt" (running): it reads this at its next tool round.');

    const throwing = makeSidebar(hostStatus({ running: ['running'] }));
    throwing.emitHostActivity.mockImplementation(() => {
      throw new Error('activity listener failed');
    });
    const throwingTool = makeMessageChatTool({ getSidebar: () => throwing });
    await expect(
      throwingTool.handler({ action: 'send', to: 'running', message: 'hello' }, context()),
    ).resolves.toBe('Delivered to #2 "Bug hunt" (running): it reads this at its next tool round.');
  });

  it('treats a reserved target as running and still routes through the shared prompt router', async () => {
    const status = hostStatus();
    status.requestChains = [
      { conversationId: 'running', userIntentEpoch: 1, stage: 'reserved', managed: false },
    ];
    const { tool, sidebar } = makeTool(status);
    const result = await tool.handler(
      { action: 'send', to: 'Bug hunt', message: 'The build is ready.' },
      context(),
    );
    expect(sidebar.deliverChatMessage).toHaveBeenCalledWith(expect.any(String), 'running');
    expect(result).toContain('(running): it reads this at its next tool round.');
  });

  it('returns actionable list lines for missing message and unresolved references', async () => {
    const { tool } = makeTool();
    const missing = await tool.handler({ action: 'send' }, context());
    expect(missing).toContain('Pass `message` with the text to deliver.');
    expect(missing).toContain('Chats in this window');
    const unresolved = await tool.handler(
      { action: 'send', to: 'missing chat', message: 'hello' },
      context(),
    );
    expect(unresolved).toContain('No open chat matches');
    expect(unresolved).toContain('#2 · Bug hunt');
    expect(unresolved).toContain('#3 · Release notes');
    expect(unresolved).toContain('#1 · Sender');
    expect(unresolved).toMatch(/send: .*only other running chat\.$/u);
  });

  it('refuses the 31st send in an hour with the next-allowed time', async () => {
    const at = Date.parse('2026-10-24T10:00:00.000Z');
    const { tool, sidebar } = makeTool(hostStatus({ running: ['running'] }), () => at);
    for (let index = 0; index < 30; index += 1) {
      await tool.handler({ action: 'send', to: 'running', message: `message ${index}` }, context());
    }
    const result = await tool.handler(
      { action: 'send', to: 'running', message: 'one too many' },
      context(),
    );
    expect(result).toContain('30-send-per-hour limit');
    expect(result).toContain('next send is allowed at 2026-10-24T11:00:00.000Z');
    expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(30);
  });

  it('expires sends at the rolling one-hour boundary and keeps caps per sending chat', async () => {
    let at = Date.parse('2026-10-24T10:00:00.000Z');
    const { tool, sidebar } = makeTool(hostStatus({ running: ['running'] }), () => at);
    for (let index = 0; index < 30; index += 1) {
      await tool.handler({ action: 'send', to: 'running', message: `message ${index}` }, context());
    }
    at += 60 * 60 * 1000;
    const afterWindow = await tool.handler(
      { action: 'send', to: 'running', message: 'window expired' },
      context(),
    );
    expect(afterWindow).toContain('Delivered to #2');
    const otherSender = await tool.handler(
      { action: 'send', to: 'sender', message: 'independent sender cap' },
      context('running'),
    );
    expect(otherSender).toContain('Delivered to #1');
    expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(32);
  });

  it('refuses the seventh idle wake in an hour with the next-allowed time', async () => {
    const at = Date.parse('2026-10-24T10:00:00.000Z');
    const { tool, sidebar } = makeTool(hostStatus(), () => at);
    for (let index = 0; index < 6; index += 1) {
      await tool.handler({ action: 'send', to: 'idle', message: `wake ${index}` }, context());
    }
    const result = await tool.handler(
      { action: 'send', to: 'idle', message: 'seventh wake' },
      context(),
    );
    expect(result).toContain('6-idle-chat-wake-per-hour limit');
    expect(result).toContain('next idle wake is allowed at 2026-10-24T11:00:00.000Z');
    expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(6);
  });

  it('reports a refused delivery as an error and does not count it against the caps', async () => {
    const at = Date.parse('2026-10-24T10:00:00.000Z');
    const { tool, sidebar } = makeTool(hostStatus(), () => at);
    sidebar.deliverChatMessage.mockResolvedValue({
      kind: 'refused',
      error: 'Forge: no active model selected. Pick a model before sending.',
    });
    for (let index = 0; index < 7; index += 1) {
      const refused = await tool.handler(
        { action: 'send', to: 'idle', message: `try ${index}` },
        context(),
      );
      expect(refused).toContain(
        '#3 "Release notes" did not accept the message: Forge: no active model',
      );
      expect(refused).toContain('Nothing was delivered');
      expect(refused).toContain('#2 · Bug hunt');
    }
    sidebar.deliverChatMessage.mockResolvedValue({ kind: 'turn' });
    const result = await tool.handler({ action: 'send', to: 'idle', message: 'now' }, context());
    expect(result).toBe('Delivered to #3 "Release notes" (idle): a turn started there.');
  });

  it('reports the actual delivery: a chat that went busy after the check gets a tell', async () => {
    const { tool, sidebar } = makeTool(hostStatus());
    sidebar.deliverChatMessage.mockResolvedValue({ kind: 'tell' });
    const result = await tool.handler({ action: 'send', to: 'idle', message: 'hi' }, context());
    expect(result).toBe(
      'Delivered to #3 "Release notes" (running): it reads this at its next tool round.',
    );
  });

  it('stops waiting for admission after 20 s and says the send is unconfirmed', async () => {
    vi.useFakeTimers();
    try {
      const { tool, sidebar } = makeTool(hostStatus());
      sidebar.deliverChatMessage.mockReturnValue(new Promise<ChatMessageDelivery>(() => {}));
      const pending = tool.handler({ action: 'send', to: 'idle', message: 'hi' }, context());
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(result).toContain(
        'its turn had not started after 20 s; it may still start. Do not resend',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting when the sending turn is aborted', async () => {
    const { tool, sidebar } = makeTool(hostStatus());
    sidebar.deliverChatMessage.mockReturnValue(new Promise<ChatMessageDelivery>(() => {}));
    const controller = new AbortController();
    const pending = tool.handler(
      { action: 'send', to: 'idle', message: 'hi' },
      { ...context(), abortSignal: controller.signal },
    );
    controller.abort();
    await expect(pending).resolves.toContain('this turn was stopped; it may still start');
  });

  it('uses delegate permission with automatic approval so sends never prompt per call', () => {
    const { tool } = makeTool();
    expect(tool.permission).toBe('delegate');
    expect(tool.autoApprove).toBe(true);
  });

  it('returns an error instead of throwing when the sidebar is unavailable', async () => {
    const tool = makeMessageChatTool({ getSidebar: () => undefined });
    await expect(tool.handler({ action: 'list' }, context())).resolves.toContain(
      'Open it and retry',
    );
  });
});
