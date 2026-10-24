import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { ForgeConfigSchema } from '../../src/config/schema';
import { makeOllamaStarterConfig } from '../../src/config/StarterConfig';
import type { ForgeConversationSummary, ForgeHostStatus } from '../../src/sidebar/ForgeHostFacade';
import { createSidebarPromptRouter } from '../../src/sidebar/backgroundExitNotice';
import type { ChatMessageDelivery } from '../../src/sidebar/backgroundExitNotice';
import { makeMessageChatTool, type MessageChatSidebar } from '../../src/tools/messageChatTool';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';

const L1_DISABLED_DEFINITION = {
  type: 'function',
  function: {
    name: 'message_chat',
    description:
      "Message another Forge chat in this window. `send`: `to` is a chat id, `#N` from `list`, or words from the chat's title; omit `to` to reach the other chat when exactly one other chat is running (or open). No `list` needed first. A running chat reads it at its next tool round; an idle chat starts a turn. Replies arrive the same way. `list`: show the chats.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'send'] },
        to: { type: 'string', minLength: 1, maxLength: 200 },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          description:
            "Write it as you would to a coworker: first person, call the other chat 'you', no formalities, no reports about yourself in the third person.",
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
};

function conversation(id: string, title = id): ForgeConversationSummary {
  return {
    id,
    title,
    activeModel: 'local-model',
    archived: false,
    updatedAt: 0,
    requestCount: 0,
    toolCallCount: 0,
    compactCount: 0,
    activeMs: 0,
  };
}

function makeRig(options: {
  actions?: { new_chat?: boolean; steer?: boolean };
  running?: string[];
  targets?: string[];
  blockers?: string[];
  clanker?: boolean;
  delivery?: ChatMessageDelivery;
} = {}) {
  const state: ForgeHostStatus = {
    activeConversationId: 'sender',
    conversations: [
      conversation('sender', 'Sender'),
      ...(options.targets ?? ['target']).map((id) => conversation(id, 'Title ' + id)),
    ],
    requestChains: [],
    streamingConversationIds: options.running ?? [],
  };
  let created = 0;
  const createConversation = vi.fn(async () => {
    created += 1;
    return conversation('new-' + created, 'Created ' + created);
  });
  const emitHostActivity = vi.fn();
  const getConfig = (): ForgeConfig => ({
    permissions: {
      chats: { new_chat: options.actions?.new_chat ?? false, steer: options.actions?.steer ?? false },
    },
  });
  const sidebar: MessageChatSidebar & {
    createConversation: typeof createConversation;
    deliverChatMessage: ReturnType<
      typeof vi.fn<(text: string, id: string, steer?: boolean) => Promise<ChatMessageDelivery>>
    >;
  } = {
    getHostFacade: () => ({
      status: () => state,
      emitHostActivity,
      chatCapBlockers: vi.fn(() => options.blockers ?? []),
      createConversation,
      clankerMode: () => options.clanker ?? false,
    }),
    createConversation,
    deliverChatMessage: vi.fn((_text: string, id: string, _steer?: boolean) =>
      Promise.resolve(
        options.delivery ??
          (state.streamingConversationIds.includes(id) ||
          state.requestChains.some((chain) => chain.conversationId === id)
            ? { kind: 'tell' }
            : { kind: 'turn' }),
      ),
    ),
  };
  const tool = makeMessageChatTool({ getSidebar: () => sidebar, getConfig });
  return { state, sidebar, tool, getConfig, emitHostActivity };
}

function context(conversationId = 'sender'): ToolHandlerContext {
  return { beforeMutate: vi.fn(), conversationId };
}

describe('message_chat new and steer actions', () => {
  it('defaults both chat capabilities off when their config block is absent or empty', () => {
    const modelConfig = makeOllamaStarterConfig('http://127.0.0.1:11434', ['test-model']);
    delete modelConfig.permissions;
    expect(ForgeConfigSchema.parse(modelConfig).permissions).toBeUndefined();
    expect(
      ForgeConfigSchema.parse({ ...modelConfig, permissions: { chats: {} } }).permissions?.chats,
    ).toEqual({ new_chat: false, steer: false });
  });

  it('pins the full disabled definition and refuses stale new/steer calls', async () => {
    const { tool } = makeRig();
    expect(JSON.stringify(tool.describe?.())).toMatchSnapshot();
    expect(JSON.stringify(tool.describe?.())).toBe(JSON.stringify(L1_DISABLED_DEFINITION));
    expect(JSON.stringify(tool.definition)).toBe(JSON.stringify(L1_DISABLED_DEFINITION));
    const noConfig = makeMessageChatTool({ getSidebar: () => undefined });
    expect(noConfig.describe?.()?.function.parameters.properties.action).toEqual({
      type: 'string',
      enum: ['list', 'send'],
    });
    await expect(tool.handler({ action: 'new', message: 'hello' }, context())).resolves.toContain(
      'not enabled in this window',
    );
    await expect(tool.handler({ action: 'steer', message: 'hello' }, context())).resolves.toContain(
      'not enabled in this window',
    );
  });

  it('advertises actions only for their flags and keeps title out of the new schema', async () => {
    const { tool } = makeRig({ actions: { new_chat: true, steer: true } });
    const definition = tool.describe?.();
    expect(definition?.function.parameters.properties.action).toEqual({
      type: 'string',
      enum: ['list', 'send', 'new', 'steer'],
    });
    expect(definition?.function.parameters.properties).not.toHaveProperty('title');
    await expect(tool.handler({ action: 'new', title: 'No rename API', message: 'hello' }, context())).rejects.toThrow();
    await expect(tool.handler({ action: 'new' }, context())).rejects.toThrow();
    await expect(tool.handler({ action: 'steer' }, context())).rejects.toThrow();
  });

  it('preflights the chat cap and creates a chat without activating it', async () => {
    const blocked = makeRig({ actions: { new_chat: true }, blockers: ['all chat slots are occupied'] });
    const refused = await blocked.tool.handler({ action: 'new', message: 'Split this task.' }, context());
    expect(refused).toContain('all chat slots are occupied');
    expect(blocked.sidebar.createConversation).not.toHaveBeenCalled();

    const rig = makeRig({ actions: { new_chat: true } });
    const result = await rig.tool.handler(
      { action: 'new', message: 'Please inspect the build output.' },
      context(),
    );
    expect(rig.sidebar.createConversation).toHaveBeenCalledWith({ activate: false });
    expect(rig.sidebar.deliverChatMessage).toHaveBeenCalledWith(
      '📨 Message from Sender (id sender):\n' +
        'Please inspect the build output.\n\n' +
        '(Reply with message_chat to "sender" if you need to; no need to just acknowledge.)',
      'new-1',
    );
    expect(rig.state.activeConversationId).toBe('sender');
    expect(result).toContain('#3 "Created 1"');
    expect(result).toContain('a turn started there');
  });

  it('enforces the two-new-chat cap and refunds refused deliveries', async () => {
    const rig = makeRig({ actions: { new_chat: true } });
    await rig.tool.handler({ action: 'new', message: 'one' }, context());
    await rig.tool.handler({ action: 'new', message: 'two' }, context());
    const capped = await rig.tool.handler({ action: 'new', message: 'three' }, context());
    expect(capped).toContain('2-new-chat-per-hour limit');
    expect(rig.sidebar.createConversation).toHaveBeenCalledTimes(2);

    const refused = makeRig({ actions: { new_chat: true }, delivery: { kind: 'refused', error: 'no model' } });
    const refusedResult = await refused.tool.handler(
      { action: 'new', message: 'retry 0' },
      context(),
    );
    expect(refusedResult).toContain('empty chat remains open');
    for (let index = 1; index < 3; index += 1) {
      await refused.tool.handler({ action: 'new', message: 'retry ' + index }, context());
    }
    expect(refused.sidebar.createConversation).toHaveBeenCalledTimes(3);
  });

  it('counts a new chat against the idle-wake cap', async () => {
    const rig = makeRig({ actions: { new_chat: true } });
    for (let index = 0; index < 6; index += 1) {
      await rig.tool.handler({ action: 'send', to: 'target', message: 'wake ' + index }, context());
    }
    const result = await rig.tool.handler({ action: 'new', message: 'one more wake' }, context());
    expect(result).toContain('6-idle-chat-wake-per-hour limit');
    expect(rig.sidebar.createConversation).not.toHaveBeenCalled();
  });

  it('routes a busy steer through the shared Send now route and emits the steering mirror status', async () => {
    const rig = makeRig({ actions: { steer: true }, running: ['target'] });
    const result = await rig.tool.handler(
      { action: 'steer', to: 'target', message: 'Stop and check the failing test.' },
      context(),
    );
    expect(rig.sidebar.deliverChatMessage).toHaveBeenCalledWith(
      expect.stringContaining('📨 Message from Sender (id sender):'),
      'target',
      true,
    );
    expect(result).toContain('current turn was interrupted');
    expect(rig.emitHostActivity.mock.calls[1]?.[0]).toMatchObject({
      text: expect.stringContaining('(steering · interrupts its turn)'),
    });
  });

  it('uses Send now internally: hold the tell, mark it, then interrupt once', () => {
    const calls: string[] = [];
    const router = createSidebarPromptRouter({
      activeId: () => 'active',
      isReserved: () => true,
      addTell: (_id, _text, _internal, tellId) => { calls.push('tell:' + tellId); },
      removeTell: () => true,
      markSendNow: (_id, tellId) => { calls.push('mark:' + tellId); return true; },
      isStreaming: () => true,
      interruptForSteering: async () => { calls.push('interrupt'); },
      send: async () => ({ kind: 'done' }),
      isOpen: () => true,
    });
    expect(router.steerChatMessage('held instruction', 'target')).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(/^tell:/u);
    expect(calls[1]).toBe(calls[0]?.replace('tell:', 'mark:'));
    expect(calls[2]).toBe('interrupt');
  });

  it('falls back to send for an idle target', async () => {
    const rig = makeRig({ actions: { steer: true } });
    const result = await rig.tool.handler(
      { action: 'steer', to: 'target', message: 'Please review the notes.' },
      context(),
    );
    expect(rig.sidebar.deliverChatMessage).toHaveBeenCalledWith(expect.any(String), 'target', false);
    expect(result).toContain('a turn started there');
  });

  it('enforces the per-sender steer cap', async () => {
    const rig = makeRig({ actions: { steer: true }, targets: ['one', 'two', 'three', 'four'] });
    for (const id of ['one', 'two', 'three']) {
      await rig.tool.handler({ action: 'steer', to: id, message: 'Check this.' }, context());
    }
    const result = await rig.tool.handler(
      { action: 'steer', to: 'four', message: 'One more.' },
      context(),
    );
    expect(result).toContain('3-steer-per-hour limit');
    expect(rig.sidebar.deliverChatMessage).toHaveBeenCalledTimes(3);
  });

  it('enforces the global two-minute target gap', async () => {
    let at = Date.parse('2026-10-24T10:00:00.000Z');
    const rig = makeRig({ actions: { steer: true } });
    rig.state.conversations.push(conversation('sender-two', 'Sender Two'));
    const tool = makeMessageChatTool({ getSidebar: () => rig.sidebar, getConfig: rig.getConfig, now: () => at });
    await tool.handler({ action: 'steer', to: 'target', message: 'First.' }, context());
    at += 119_999;
    const result = await tool.handler(
      { action: 'steer', to: 'target', message: 'Too soon.' },
      context('sender-two'),
    );
    expect(result).toContain('steered too recently');
    expect(rig.sidebar.deliverChatMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses steering into a turn started by the same sender', async () => {
    let at = Date.parse('2026-10-24T10:00:00.000Z');
    const rig = makeRig({ actions: { steer: true }, running: ['target'] });
    rig.state.requestChains = [
      { conversationId: 'target', userIntentEpoch: 1, stage: 'running', managed: true },
    ];
    const tool = makeMessageChatTool({ getSidebar: () => rig.sidebar, getConfig: rig.getConfig, now: () => at });
    await tool.handler({ action: 'steer', to: 'target', message: 'First steer.' }, context());
    rig.state.requestChains[0] = { ...rig.state.requestChains[0]!, userIntentEpoch: 2 };
    at += 120_000;
    const result = await tool.handler({ action: 'steer', to: 'target', message: 'Ping pong.' }, context());
    expect(result).toContain('refusing a steer loop');
    expect(rig.sidebar.deliverChatMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses while the target has a pending approval prompt', async () => {
    const rig = makeRig({ actions: { steer: true }, running: ['target'] });
    rig.state.pendingApproval = { conversationId: 'target' } as NonNullable<ForgeHostStatus['pendingApproval']>;
    const result = await rig.tool.handler(
      { action: 'steer', to: 'target', message: 'Please continue.' },
      context(),
    );
    expect(result).toContain("waiting for the owner's approval");
    expect(rig.sidebar.deliverChatMessage).not.toHaveBeenCalled();
  });

  it('asks the owner per steer outside clanker mode', () => {
    const regular = makeRig({ actions: { steer: true } });
    expect(regular.tool.approval?.({ action: 'steer' })).toMatchObject({ dangerous: true });
    const clanker = makeRig({ actions: { steer: true }, clanker: true });
    expect(clanker.tool.approval?.({ action: 'steer' })).toBeUndefined();
  });
});
