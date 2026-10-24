import { describe, expect, it, vi } from 'vitest';
import type {
  ForgeConversationSummary,
  ForgeHostFacade,
  ForgeHostStatus,
} from '../../src/sidebar/ForgeHostFacade';
import type { ChatMessageDelivery } from '../../src/sidebar/backgroundExitNotice';
import { makeMessageChatTool, type MessageChatSidebar } from '../../src/tools/messageChatTool';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';

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
  typeof vi.fn<(text: string, id: string) => Promise<ChatMessageDelivery>>
>;

/** Mirrors the router: a busy (streaming or reserved) chat takes a tell, an idle one a turn. */
function makeSidebar(status: ForgeHostStatus): MessageChatSidebar & {
  deliverChatMessage: DeliverMock;
  emitHostActivity: ReturnType<typeof vi.fn>;
} {
  const emitHostActivity = vi.fn();
  return {
    getHostFacade: () => ({ status: () => status, emitHostActivity }),
    emitHostActivity,
    deliverChatMessage: vi.fn((_text: string, id: string) =>
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
        action: { type: 'string', enum: ['list', 'send'] },
        to: { type: 'string', minLength: 1, maxLength: 200 },
        message: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['action'],
      additionalProperties: false,
    });
    await expect(tool.handler({ action: 'list', extra: true }, context())).rejects.toThrow();
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
      '[message_chat from #1 "Sender" (id sender)]\n' +
        'The parser test is ready.\n\n' +
        '(Answer with message_chat to "sender" only if a reply is needed; do not reply just to acknowledge.)',
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
      expect.stringContaining('[message_chat from #1'),
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
      [{ kind: 'prompt', conversationId: 'running', text: `📨 from #1 "Sender": ${'x'.repeat(499)}…` }],
      [{ kind: 'prompt', conversationId: 'sender', text: `📤 to #2 "Bug hunt" (running): ${'x'.repeat(499)}…` }],
    ]);
  });

  it('uses the delivery outcome in the sender activity line', async () => {
    const { tool, sidebar } = makeTool();
    sidebar.deliverChatMessage.mockResolvedValue({ kind: 'turn' });
    await tool.handler({ action: 'send', to: 'idle', message: 'Please review.' }, context());
    expect(sidebar.emitHostActivity.mock.calls).toEqual([
      [{ kind: 'prompt', conversationId: 'idle', text: '📨 from #1 "Sender": Please review.' }],
      [{ kind: 'prompt', conversationId: 'sender', text: '📤 to #3 "Release notes" (idle, turn started): Please review.' }],
    ]);
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
        [{ kind: 'prompt', conversationId: 'idle', text: '📨 from #1 "Sender": Please review.' }],
        [{ kind: 'prompt', conversationId: 'sender', text: '📤 to #3 "Release notes" (not confirmed yet): Please review.' }],
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
