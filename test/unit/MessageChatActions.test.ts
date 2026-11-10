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
      "Message another Forge chat. `to` is a chat id, `#N` from `list`, or words from the chat's title — `#N` and title words mean this window's chats; a chat in another Forge window on this machine takes its id, or its first 8 or more characters when no other chat's id starts the same way. Omit `to` to reach the other chat when exactly one other chat is running (or open); otherwise an omitted `to` answers the chat in another window that last wrote to this one. No `list` needed first. A running chat reads it at its next tool round; an idle chat starts a turn. Replies arrive the same way. `list`: show the chats, including other windows'. `action` defaults to `send` when a `message` is given, so a message alone is enough. `view`: read what one named chat has done — its last prompt/answer pairs, at most 10; `to` is required, and reading changes nothing. `view` also reads a closed chat by id or title, and marks the result `closed`.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'send', 'view'] },
        to: {
          type: 'string',
          maxLength: 200,
          description:
            'Another chat only: use its chat id, its #N tab number from list, or words from its title. #N and title words reach only this window\'s chats; a chat in another window takes its id or a unique prefix of 8 or more characters. Never target this chat. A closed chat must be read with action: view.',
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 12000,
          description:
            "Write it as you would to a coworker: first person, call the other chat 'you', no formalities, no reports about yourself in the third person. At most 12,000 characters; send a longer message in parts.",
        },
      },
      // No field is required now: a message alone is a send (lane 5 phase 5.4).
      // The rest of this definition is the owner-approved eager schema the
      // tool-schema budget pins, so it is written out here and snapshotted.
      required: [],
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
  /** What `permissions.chats.new_chats_per_hour` is set to, for the cap test. */
  newChatsPerHour?: number;
  /** The model names `config.yaml` carries, for the `model` preflight. */
  models?: string[];
  /** Make `setConversationModel` throw, the way the facade does when the chat it
   *  was asked to pin is gone or the name cannot be applied. */
  pinError?: string;
  /** Whether `applyAutoTitle` accepts the name the tool proposes. */
  titled?: boolean;
  /** Make the notice line fail after the worker's first message is delivered. */
  noticeThrows?: boolean;
  /** Closed chats in recent history: the archived rows `status()` reports once a
   *  tab is closed, appended after the open tabs in the order the sidebar holds
   *  them. `view` can read these; `send` and `steer` must refuse them. */
  closed?: { id: string; title: string }[];
  /** The exchanges `recentExchanges` answers with, oldest first, for `view`. */
  exchanges?: { prompt: string; answer: string }[];
  /** Put a created chat in the tab list, as the sidebar does, so a later call
   *  can address it by the title the tool gave it. The default is on because
   *  that is what a create does; `adopt: false` is only for a chat the tool
   *  opened and could not reach. */
  adopt?: boolean;
} = {}) {
  const state: ForgeHostStatus = {
    activeConversationId: 'sender',
    conversations: [
      conversation('sender', 'Sender'),
      ...(options.targets ?? ['target']).map((id) => conversation(id, 'Title ' + id)),
      ...(options.closed ?? []).map((chat) => ({
        ...conversation(chat.id, chat.title),
        archived: true,
      })),
    ],
    requestChains: [],
    streamingConversationIds: options.running ?? [],
  };
  let created = 0;
  const createConversation = vi.fn(async () => {
    created += 1;
    const fresh = conversation('new-' + created, 'Created ' + created);
    if (options.adopt !== false) state.conversations.push(fresh);
    return fresh;
  });
  const emitHostActivity = vi.fn();
  const showConversationNotice = vi.fn((_id: string, _notice: string) => {
    if (options.noticeThrows) throw new Error('notice unavailable');
  });
  const setConversationModel = vi.fn(async (_id: string, _model: string | null) => {
    if (options.pinError !== undefined) throw new Error(options.pinError);
  });
  // The real `applyAutoTitle` renames the tab, so `status()` reports the new name
  // afterwards; a fake that only answered true would let a test pass on a title
  // no later call could ever resolve.
  const applyAutoTitle = vi.fn((id: string, title: string) => {
    const row = state.conversations.find((other) => other.id === id);
    if (!row || options.titled === false) return false;
    row.title = title;
    return true;
  });
  const recentExchanges = vi.fn((_id: string, _limit: number) => options.exchanges ?? []);
  const getConfig = (): ForgeConfig => ({
    models: (options.models ?? ['local-model']).map((name) => ({ name })) as ForgeConfig['models'],
    active_model: 'local-model',
    llama_server: {} as ForgeConfig['llama_server'],
    permissions: {
      chats: {
        new_chat: options.actions?.new_chat ?? false,
        steer: options.actions?.steer ?? false,
        ...(options.newChatsPerHour !== undefined
          ? { new_chats_per_hour: options.newChatsPerHour }
          : {}),
      },
    },
  });
  const sidebar: MessageChatSidebar & {
    createConversation: typeof createConversation;
    setConversationModel: typeof setConversationModel;
    applyAutoTitle: typeof applyAutoTitle;
    recentExchanges: typeof recentExchanges;
    deliverChatMessage: ReturnType<
      typeof vi.fn<(text: string, id: string, steer?: boolean) => Promise<ChatMessageDelivery>>
    >;
  } = {
    getHostFacade: () => ({
      status: () => state,
      emitHostActivity,
      chatCapBlockers: vi.fn(() => options.blockers ?? []),
      createConversation,
      setConversationModel,
      applyAutoTitle,
      recentExchanges,
      showConversationNotice,
      // Clanker is read for the chat that is sending, so the fake answers for every
      // chat except the one the per-chat case below asks about.
      clankerMode: (conversationId: string) =>
        options.clanker === true && conversationId !== 'someone-else',
    }),
    createConversation,
    setConversationModel,
    applyAutoTitle,
    recentExchanges,
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
  return { state, sidebar, tool, getConfig, emitHostActivity, showConversationNotice };
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
    ).toEqual({ new_chat: false, steer: false, new_chats_per_hour: 100 });
    expect(
      ForgeConfigSchema.parse({
        ...modelConfig,
        permissions: { chats: { new_chat: true, new_chats_per_hour: 6 } },
      }).permissions?.chats,
    ).toEqual({ new_chat: true, steer: false, new_chats_per_hour: 6 });
  });

  it('pins the full disabled definition and refuses stale new/steer calls', async () => {
    const { tool } = makeRig();
    expect(JSON.stringify(tool.describe?.())).toMatchSnapshot();
    expect(JSON.stringify(tool.describe?.())).toBe(JSON.stringify(L1_DISABLED_DEFINITION));
    expect(JSON.stringify(tool.definition)).toBe(JSON.stringify(L1_DISABLED_DEFINITION));
    const noConfig = makeMessageChatTool({ getSidebar: () => undefined });
    expect(noConfig.describe?.()?.function.parameters.properties.action).toEqual({
      type: 'string',
      enum: ['list', 'send', 'view'],
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
      enum: ['list', 'send', 'view', 'new', 'steer'],
    });
    expect(definition?.function.parameters.properties).not.toHaveProperty('title');
    // `model` is advertised only where it means something: `new` is the action
    // that opens a chat, and a chat already open keeps the model it has.
    expect(definition?.function.parameters.properties).toHaveProperty('model');
    const sendOnly = makeRig({ actions: { steer: true } });
    expect(sendOnly.tool.describe?.()?.function.parameters.properties).not.toHaveProperty('model');
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
    expect(rig.sidebar.createConversation).toHaveBeenCalledWith({
      activate: false,
      openedBy: 'sender',
    });
    expect(rig.sidebar.setConversationModel).toHaveBeenCalledWith(
      'new-1',
      'local-model',
    );
    expect(rig.sidebar.deliverChatMessage).toHaveBeenCalledWith(
      '📨 Message from Sender (id sender):\n' +
        'Please inspect the build output.\n\n' +
        '(Reply with message_chat to "sender" if you need to; no need to just acknowledge.)',
      'new-1',
    );
    expect(rig.state.activeConversationId).toBe('sender');
    // Named after its task, not `Untitled chat`: a supervisor that opens two
    // workers at once cannot tell them apart by id alone, and the tab list is
    // the only place it can look without reading both transcripts.
    expect(rig.sidebar.applyAutoTitle).toHaveBeenCalledWith(
      'new-1',
      'Sender: Please inspect the build output.',
    );
    expect(result).toContain('#3 "Sender: Please inspect the build output."');
    expect(result).toContain('model local-model');
    expect(result).toContain('a turn started there');
  });

  it('tells the opener when a new worker inherits Clanker and steer is available', async () => {
    const rig = makeRig({ clanker: true, actions: { new_chat: true, steer: true } });
    const result = await rig.tool.handler(
      { action: 'new', message: 'Please inspect the build output.' },
      context(),
    );
    expect(result).toBe(
      'Opened #3 "Sender: Please inspect the build output." on model local-model (idle): a turn started there.\n' +
        'Clanker is on in #3 "Sender: Please inspect the build output.", inherited from this chat: it runs without approval cards, except at Clanker\'s three stops (destructive actions, Forge guard files, a secret read followed by egress). Tell the user. While it works, check on it with message_chat `view`; if it runs commands you did not ask for, interrupt it with `steer` and tell the user what you saw.',
    );
    expect(rig.showConversationNotice).toHaveBeenCalledTimes(1);
    expect(rig.showConversationNotice).toHaveBeenCalledWith(
      'sender',
      'Opened #3 "Sender: Please inspect the build output." with Clanker on, inherited from this chat. Its three stops still hold; turn it off there with /clanker.',
    );
  });

  it('tells the opener when a new worker inherits Clanker and steer is unavailable', async () => {
    const rig = makeRig({ clanker: true, actions: { new_chat: true } });
    const result = await rig.tool.handler(
      { action: 'new', message: 'Please inspect the build output.' },
      context(),
    );
    expect(result).toBe(
      'Opened #3 "Sender: Please inspect the build output." on model local-model (idle): a turn started there.\n' +
        'Clanker is on in #3 "Sender: Please inspect the build output.", inherited from this chat: it runs without approval cards, except at Clanker\'s three stops (destructive actions, Forge guard files, a secret read followed by egress). Tell the user. While it works, check on it with message_chat `view`; if it runs commands you did not ask for, tell the user what you saw.',
    );
    expect(rig.showConversationNotice).toHaveBeenCalledTimes(1);
    expect(rig.showConversationNotice).toHaveBeenCalledWith(
      'sender',
      'Opened #3 "Sender: Please inspect the build output." with Clanker on, inherited from this chat. Its three stops still hold; turn it off there with /clanker.',
    );
  });

  it('leaves the result and notice unchanged when the new worker has Clanker off', async () => {
    const rig = makeRig({ actions: { new_chat: true, steer: true } });
    const result = await rig.tool.handler(
      { action: 'new', message: 'Please inspect the build output.' },
      context(),
    );
    expect(result).toBe(
      'Opened #3 "Sender: Please inspect the build output." on model local-model (idle): a turn started there.',
    );
    expect(rig.showConversationNotice).not.toHaveBeenCalled();
  });

  it('keeps a successful delivery result when its Clanker notice throws', async () => {
    const rig = makeRig({ clanker: true, actions: { new_chat: true }, noticeThrows: true });
    const result = await rig.tool.handler(
      { action: 'new', message: 'Please inspect the build output.' },
      context(),
    );
    expect(result).toBe(
      'Opened #3 "Sender: Please inspect the build output." on model local-model (idle): a turn started there.\n' +
        'Clanker is on in #3 "Sender: Please inspect the build output.", inherited from this chat: it runs without approval cards, except at Clanker\'s three stops (destructive actions, Forge guard files, a secret read followed by egress). Tell the user. While it works, check on it with message_chat `view`; if it runs commands you did not ask for, tell the user what you saw.',
    );
    expect(rig.showConversationNotice).toHaveBeenCalledTimes(1);
  });

  it('enforces the two-new-chat cap and refunds refused deliveries', async () => {
    const rig = makeRig({ actions: { new_chat: true }, newChatsPerHour: 2 });
    await rig.tool.handler({ action: 'new', message: 'one' }, context());
    await rig.tool.handler({ action: 'new', message: 'two' }, context());
    const capped = await rig.tool.handler({ action: 'new', message: 'three' }, context());
    expect(capped).toContain('2-new-chat-per-30-min limit');
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
    for (let index = 0; index < 20; index += 1) {
      await rig.tool.handler({ action: 'send', to: 'target', message: 'wake ' + index }, context());
    }
    const result = await rig.tool.handler({ action: 'new', message: 'one more wake' }, context());
    expect(result).toContain('20-idle-chat-wake-per-30-min limit');
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
    // The router interrupts only a chat that is generating, so the result must
    // not claim an interrupt that may not have happened (BL-008).
    expect(result).toContain('interrupted only if it is generating');
    expect(result).not.toContain('the current turn was interrupted');
    expect(rig.emitHostActivity.mock.calls[1]?.[0]).toMatchObject({
      text: expect.stringContaining(
        '(steering · interrupts its turn if it is generating)',
      ),
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

  it('asks the owner for a steer unless the SENDING chat has Clanker armed', () => {
    const regular = makeRig({ actions: { steer: true } });
    expect(
      regular.tool.approval?.({ action: 'steer' }, { conversationId: 'sender' }),
    ).toMatchObject({ dangerous: true });
    const clanker = makeRig({ actions: { steer: true }, clanker: true });
    expect(clanker.tool.approval?.({ action: 'steer' }, { conversationId: 'sender' })).toBeUndefined();
    // The mode belongs to the chat that is sending, not to the window: the same tool
    // with the same fake sidebar asks when a different chat is the one calling.
    expect(
      clanker.tool.approval?.({ action: 'steer' }, { conversationId: 'someone-else' }),
    ).toMatchObject({ dangerous: true });
  });

  it('pins a worker to the model its sender is already on', async () => {
    const rig = makeRig({ actions: { new_chat: true } });
    await rig.tool.handler({ action: 'new', message: 'Take the build.' }, context());
    // The sender's chat model, not `config.active_model`: a worker on the
    // default would load a second engine beside the one already serving.
    expect(rig.sidebar.setConversationModel).toHaveBeenCalledWith('new-1', 'local-model');
  });

  it('refuses a model config does not name before opening anything', async () => {
    const rig = makeRig({ actions: { new_chat: true }, models: ['local-model'] });
    const refused = await rig.tool.handler(
      { action: 'new', message: 'Take the build.', model: 'ghost-model' },
      context(),
    );
    expect(refused).toContain('does not name a model in config.yaml');
    expect(refused).toContain('local-model');
    expect(refused).toContain('Nothing was created and no counter was used');
    expect(rig.sidebar.createConversation).not.toHaveBeenCalled();
    expect(rig.sidebar.setConversationModel).not.toHaveBeenCalled();
    expect(rig.sidebar.deliverChatMessage).not.toHaveBeenCalled();
    // The refusal burned nothing, so the very next `new` still opens a chat.
    const after = await rig.tool.handler({ action: 'new', message: 'Take the build.' }, context());
    expect(after).toContain('a turn started there');
    expect(rig.sidebar.createConversation).toHaveBeenCalledTimes(1);
  });

  it('pins the model the call named and keeps a profile that resolves', async () => {
    const rig = makeRig({ actions: { new_chat: true }, models: ['local-model'] });
    const result = await rig.tool.handler(
      { action: 'new', message: 'Take the build.', model: 'local-model' },
      context(),
    );
    expect(rig.sidebar.setConversationModel).toHaveBeenCalledWith('new-1', 'local-model');
    expect(result).toContain('model local-model');
  });

  it('refuses before delivery when the pin fails, and refunds the counters', async () => {
    const rig = makeRig({
      actions: { new_chat: true },
      newChatsPerHour: 1,
      pinError: 'conversation not found',
    });
    const refused = await rig.tool.handler({ action: 'new', message: 'Take the build.' }, context());
    expect(refused).toContain('could not be pinned to local-model');
    expect(refused).toContain('loads a second engine');
    // Delivering to an unpinned chat would start a turn on the stale default and
    // load it, so the message must not have gone.
    expect(rig.sidebar.deliverChatMessage).not.toHaveBeenCalled();
    const second = await rig.tool.handler({ action: 'new', message: 'Again.' }, context());
    // The refund is what this asserts: an unrefunded counter would have answered
    // `1-new-chat-per-30-min limit` here, and the sender would have lost its whole
    // window to a chat that never got a message.
    expect(second).not.toContain('new-chat-per-30-min limit');
    expect(second).toContain('could not be pinned');
    expect(rig.sidebar.createConversation).toHaveBeenCalledTimes(2);
  });

  it('leaves the title alone when the rename does not take', async () => {
    const rig = makeRig({ actions: { new_chat: true }, titled: false });
    const result = await rig.tool.handler({ action: 'new', message: 'Take the build.' }, context());
    expect(rig.sidebar.applyAutoTitle).toHaveBeenCalledWith('new-1', 'Sender: Take the build.');
    expect(result).toContain('#3 "Created 1"');
  });

  it('honours permissions.chats.new_chats_per_hour', async () => {
    // Three, not a hundred: a `new` also counts as an idle wake, and the 20-wake
    // cap is the ceiling that binds first, so a dial above twenty changes nothing.
    const configured = makeRig({ actions: { new_chat: true }, newChatsPerHour: 3 });
    for (let index = 0; index < 3; index += 1) {
      await configured.tool.handler({ action: 'new', message: `worker ${index}` }, context());
    }
    const capped = await configured.tool.handler(
      { action: 'new', message: 'one too many' },
      context(),
    );
    expect(capped).toContain('3-new-chat-per-30-min limit');
    expect(capped).toContain('next new chat is allowed at');
    expect(configured.sidebar.createConversation).toHaveBeenCalledTimes(3);

    // The dial at 2 (explicit): the third `new` is refused by the dial itself —
    // the unset case now defaults to 100, where the 20-wake cap binds first.
    const defaultRig = makeRig({ actions: { new_chat: true }, newChatsPerHour: 2 });
    await defaultRig.tool.handler({ action: 'new', message: 'worker one' }, context());
    await defaultRig.tool.handler({ action: 'new', message: 'worker two' }, context());
    const atTwo = await defaultRig.tool.handler(
      { action: 'new', message: 'worker three' },
      context(),
    );
    expect(atTwo).toContain('2-new-chat-per-30-min limit');
    expect(defaultRig.sidebar.createConversation).toHaveBeenCalledTimes(2);
  });

  it('finds a created chat by the task in its title, without a list call', async () => {
    const rig = makeRig({ actions: { new_chat: true } });
    const created = await rig.tool.handler(
      { action: 'new', message: 'Inspect the failing parser test.' },
      context(),
    );
    expect(created).toContain('Sender: Inspect the failing parser test.');
    // The tab list is the only place a supervisor can look without reading both
    // transcripts, so the name has to be enough to address the worker again.
    const followUp = await rig.tool.handler(
      { action: 'send', to: 'parser test', message: 'Stop and report.' },
      context(),
    );
    expect(followUp).toContain('#3 "Sender: Inspect the failing parser test."');
    expect(rig.sidebar.deliverChatMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('Stop and report.'),
      'new-1',
    );
  });

  it('views a chat without sending anything or burning a counter', async () => {
    const rig = makeRig({
      exchanges: [
        { prompt: 'prompt one', answer: 'answer one' },
        { prompt: 'prompt two', answer: 'answer two' },
      ],
    });
    const view = await rig.tool.handler({ action: 'view', to: '#2' }, context());
    expect(view).toContain('View of #2 "Title target" (id target):');
    expect(view).toContain('[1/2] You: prompt one');
    expect(view).toContain('answer two');
    expect(rig.sidebar.recentExchanges).toHaveBeenCalledWith('target', 11);
    expect(rig.sidebar.deliverChatMessage).not.toHaveBeenCalled();
    expect(rig.sidebar.createConversation).not.toHaveBeenCalled();
    // Six more views cost the sender nothing, so a supervisor can watch a worker
    // as often as it has turns; the caps still bind on the sends.
    for (let index = 0; index < 6; index += 1) {
      await rig.tool.handler({ action: 'view', to: '#2' }, context());
    }
    const wake = await rig.tool.handler({ action: 'send', to: 'target', message: 'wake' }, context());
    expect(wake).toContain('a turn started there');
  });

  it('clamps a long view at ten and says so', async () => {
    const names = [
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
      'golf',
      'hotel',
      'india',
      'juliet',
      'kilo',
    ];
    const rig = makeRig({
      exchanges: names.map((name) => ({ prompt: `ask ${name}`, answer: `reply ${name}` })),
    });
    const view = await rig.tool.handler({ action: 'view', to: 'target' }, context());
    expect(view).toContain('showing the last 10, the maximum');
    // The count is what was fetched, not what was kept: the eleven exchanges came
    // back and ten were shown, so the oldest one is gone rather than renumbered.
    expect(view).toContain('[1/10] You: ask bravo');
    expect(view).toContain('[10/10] You: ask kilo');
    expect(view).not.toContain('alpha');
  });

  it('says when the chat it read is mid-turn, and when it has said nothing yet', async () => {
    const busy = makeRig({
      running: ['target'],
      exchanges: [{ prompt: 'ask one', answer: 'reply one' }],
    });
    const view = await busy.tool.handler({ action: 'view', to: 'target' }, context());
    // A worker's last answer is still being written, and a supervisor that reads
    // it mid-turn must know the tail is not the whole of it.
    expect(view).toContain('a turn is running; the last entry may be partial');

    const quiet = makeRig({});
    const empty = await quiet.tool.handler({ action: 'view', to: 'target' }, context());
    expect(empty).toContain('No answers in this chat yet.');
    expect(empty).toContain('View of #2 "Title target"');
  });

  it('names the chat a view reads, never this one and never whichever is busy', async () => {
    const noTarget = makeRig({ running: ['target'] });
    await expect(noTarget.tool.handler({ action: 'view' }, context())).rejects.toThrow();
    const self = makeRig({ running: ['target'] });
    const selfView = await self.tool.handler({ action: 'view', to: 'sender' }, context());
    expect(selfView).toContain('That is this chat');
    expect(self.sidebar.recentExchanges).not.toHaveBeenCalled();
    const stale = makeRig({ running: ['target'] });
    const staleView = await stale.tool.handler(
      { action: 'view', to: 'a chat that has closed' },
      context(),
    );
    expect(staleView).toContain('No open chat matches');
    expect(staleView).toContain('#2 · Title target');
    expect(stale.sidebar.recentExchanges).not.toHaveBeenCalled();
    // The active chat is not a fallback: with a worker running, an omitted `to`
    // would have read whichever chat happened to be busy instead of the one asked for.
    expect(noTarget.sidebar.recentExchanges).not.toHaveBeenCalled();
  });

  it('views a closed chat in recent history and marks the read closed', async () => {
    const rig = makeRig({
      closed: [{ id: 'worker-closed', title: 'Sender: Take the build.' }],
      exchanges: [
        { prompt: 'prompt one', answer: 'answer one' },
        { prompt: 'prompt two', answer: 'answer two' },
      ],
    });
    const view = await rig.tool.handler({ action: 'view', to: 'worker-closed' }, context());
    // A closed chat has no tab number to name it by, and the supervisor has to
    // see that it cannot send there: the header quotes the title and says closed.
    expect(view).toContain('View of "Sender: Take the build." (id worker-closed, closed):');
    expect(view).toContain('[1/2] You: prompt one');
    expect(view).toContain('answer two');
    // Nothing is mid-turn in a chat that is not open, so the partial-tail note
    // never appears on a closed view.
    expect(view).not.toContain('a turn is running');
    expect(rig.sidebar.recentExchanges).toHaveBeenCalledWith('worker-closed', 11);
    expect(rig.sidebar.deliverChatMessage).not.toHaveBeenCalled();
    expect(rig.sidebar.createConversation).not.toHaveBeenCalled();
    expect(rig.emitHostActivity).not.toHaveBeenCalled();
    // Reading it does not reopen it: `list` still names only the open tabs.
    expect(await rig.tool.handler({ action: 'list' }, context())).not.toContain('Take the build');
    // `view` of this chat is still refused, closed chats or not.
    expect(await rig.tool.handler({ action: 'view', to: 'sender' }, context())).toContain(
      'That is this chat',
    );
  });

  it('resolves a closed chat by a unique id prefix or by words from its title', async () => {
    const rig = makeRig({ closed: [{ id: 'worker-closed-1', title: 'Sender: Inspect the parser' }] });
    for (const ref of ['worker-', 'parser', 'inspect parser']) {
      const view = await rig.tool.handler({ action: 'view', to: ref }, context());
      expect(view).toContain(
        'View of "Sender: Inspect the parser" (id worker-closed-1, closed):',
      );
    }
    expect(rig.sidebar.recentExchanges).toHaveBeenCalledTimes(3);
  });

  it('prefers an open chat over a closed chat that matches the same reference', async () => {
    const rig = makeRig({
      closed: [{ id: 'closed-twin', title: 'Title target' }],
      exchanges: [{ prompt: 'open prompt', answer: 'open answer' }],
    });
    const view = await rig.tool.handler({ action: 'view', to: 'Title target' }, context());
    expect(view).toContain('View of #2 "Title target" (id target):');
    expect(view).not.toContain(', closed');
    expect(rig.sidebar.recentExchanges).toHaveBeenCalledWith('target', 11);
    expect(rig.sidebar.recentExchanges).not.toHaveBeenCalledWith('closed-twin', 11);
  });

  it('does not fall back to a closed chat when the open chats match ambiguously', async () => {
    const rig = makeRig({
      targets: ['parser one', 'parser two'],
      closed: [{ id: 'closed-notes', title: 'Sender: Parser notes' }],
    });
    const view = await rig.tool.handler({ action: 'view', to: 'parser' }, context());
    expect(view).toContain('matches multiple chats at this level');
    expect(view).toContain('#2 "Title parser one"');
    expect(view).not.toContain('Parser notes');
    expect(rig.sidebar.recentExchanges).not.toHaveBeenCalled();
  });

  it('refuses a closed reference that matches two closed chats, listing both', async () => {
    const rig = makeRig({
      closed: [
        { id: 'closed-1111', title: 'Sender: Worker report' },
        { id: 'closed-2222', title: 'Sender: Worker report 2' },
      ],
    });
    const view = await rig.tool.handler({ action: 'view', to: 'worker report' }, context());
    expect(view).toContain('matches multiple chats at this level');
    expect(view).toContain('"Sender: Worker report" (id closed-1111, closed)');
    expect(view).toContain('"Sender: Worker report 2" (id closed-2222, closed)');
    // A closed chat has no tab number to pass back, so only its id is offered.
    expect(view).toContain("Pass `to` as one of those chats' ids.");
    expect(rig.sidebar.recentExchanges).not.toHaveBeenCalled();
  });

  it('never resolves a tab number to a closed chat', async () => {
    const rig = makeRig({ closed: [{ id: 'closed-1', title: 'Old worker' }] });
    for (const ref of ['#4', '#0', '4']) {
      const view = await rig.tool.handler({ action: 'view', to: ref }, context());
      expect(view).toContain('No open chat matches');
      // The closed pass never consults tab positions, so the refusal keeps the
      // open-chat wording instead of pointing at a tab a closed chat has no.
      expect(view).not.toContain(', closed');
    }
    expect(rig.sidebar.recentExchanges).not.toHaveBeenCalled();
  });

  it('refuses send and steer to a closed chat, and delivers and counts nothing', async () => {
    const rig = makeRig({
      actions: { steer: true },
      closed: [{ id: 'closed-worker', title: 'Sender: Take the build.' }],
    });
    const send = await rig.tool.handler(
      { action: 'send', to: 'closed-worker', message: 'Report back.' },
      context(),
    );
    expect(send).toContain('No open chat matches');
    expect(send).toContain('That chat is closed; `view` can still read it.');
    const steer = await rig.tool.handler(
      { action: 'steer', to: 'closed-worker', message: 'Stop and report.' },
      context(),
    );
    expect(steer).toContain('No open chat matches');
    expect(steer).toContain('That chat is closed; `view` can still read it.');
    expect(rig.sidebar.deliverChatMessage).not.toHaveBeenCalled();
    expect(rig.emitHostActivity).not.toHaveBeenCalled();
    expect(rig.sidebar.createConversation).not.toHaveBeenCalled();
    // Nothing was counted, so a closed worker cannot eat the sender's window: the
    // idle-wake cap still binds at exactly twenty wakes, as it did before.
    for (let index = 0; index < 20; index += 1) {
      await rig.tool.handler({ action: 'send', to: 'target', message: 'wake ' + index }, context());
    }
    const capped = await rig.tool.handler(
      { action: 'send', to: 'target', message: 'one too many' },
      context(),
    );
    expect(capped).toContain('20-idle-chat-wake-per-30-min limit');
  });

  it('refuses a chat in neither the open tabs nor recent history as before', async () => {
    const rig = makeRig({ closed: [{ id: 'closed-worker', title: 'Sender: Take the build.' }] });
    const view = await rig.tool.handler({ action: 'view', to: 'overflow-only chat' }, context());
    const send = await rig.tool.handler(
      { action: 'send', to: 'overflow-only chat', message: 'Report back.' },
      context(),
    );
    for (const result of [view, send]) {
      expect(result).toContain('No open chat matches');
      // It is not in recent history either, so the closed-chat note is not
      // offered: this change reads no further back than `status()` already does.
      expect(result).not.toContain('That chat is closed');
      expect(result).not.toContain(', closed');
    }
    expect(rig.sidebar.recentExchanges).not.toHaveBeenCalled();
    expect(rig.sidebar.deliverChatMessage).not.toHaveBeenCalled();
  });

  it('refuses a model on the actions that cannot take one', async () => {
    const rig = makeRig({ actions: { new_chat: true, steer: true } });
    await expect(
      rig.tool.handler({ action: 'send', to: 'target', message: 'hi', model: 'local-model' }, context()),
    ).rejects.toThrow();
    await expect(
      rig.tool.handler({ action: 'view', to: 'target', model: 'local-model' }, context()),
    ).rejects.toThrow();
    await expect(
      rig.tool.handler({ action: 'view', to: 'target', message: 'not a send' }, context()),
    ).rejects.toThrow();
    expect(rig.sidebar.deliverChatMessage).not.toHaveBeenCalled();
  });
});
