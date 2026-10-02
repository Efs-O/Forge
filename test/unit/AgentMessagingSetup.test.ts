import { describe, expect, it, vi } from 'vitest';
import {
  busModelIds,
  interruptForgeForSender,
  submitBusMessage,
} from '../../src/vscode/agentMessagingSetup';
import { forgeInboundPrompt } from '../../src/agentBus/busContent';
import type { ForgeConfig } from '../../src/config/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

describe('agent bus conversation targeting', () => {
  it('steers the sender conversation, not the currently visible conversation', async () => {
    const interrupt = vi.fn(async () => {});
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        streamingConversationIds: ['sender-chat'],
        conversations: [
          { id: 'visible', title: 'Visible', updatedAt: 2 },
          { id: 'sender-chat', title: 'Codex: task', updatedAt: 1 },
        ],
      }),
      recentExchanges: () => [],
      interrupt,
    } as unknown as ForgeHostFacade;

    await expect(interruptForgeForSender(facade, 'codex')).resolves.toEqual({
      steered: true,
      conversationId: 'sender-chat',
      title: 'Codex: task',
    });
    expect(interrupt).toHaveBeenCalledExactlyOnceWith('sender-chat');
  });

  it('reports that no turn was stopped when the sender conversation is idle', async () => {
    const interrupt = vi.fn(async () => {});
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        streamingConversationIds: ['visible'],
        conversations: [
          { id: 'visible', title: 'Visible', updatedAt: 2 },
          { id: 'sender-chat', title: 'Codex: task', updatedAt: 1 },
        ],
      }),
      recentExchanges: () => [],
      interrupt,
    } as unknown as ForgeHostFacade;

    await expect(interruptForgeForSender(facade, 'codex')).resolves.toMatchObject({
      steered: false,
      reason: expect.stringContaining('not streaming'),
    });
    expect(interrupt).not.toHaveBeenCalled();
  });

  it.each([
    { options: { from: 'codex' }, conversationId: 'sender-chat', creates: 0, restores: 1 },
    {
      options: { from: 'codex', newChat: true },
      conversationId: 'new-chat',
      creates: 1,
      restores: 0,
    },
  ])(
    'routes the bus message to $conversationId',
    async ({ options, conversationId, creates, restores }) => {
      const createConversation = vi.fn(async () => ({ id: 'new-chat' }) as never);
      const restoreConversation = vi.fn(async () => ({}) as never);
      const send = vi.fn(async () => ({ kind: 'completed' as const }));
      const facade = {
        status: () => ({
          activeConversationId: 'visible',
          conversations: [
            { id: 'visible', title: 'Visible', updatedAt: 2 },
            { id: 'sender-chat', title: 'Codex: task', updatedAt: 1 },
          ],
        }),
        recentExchanges: () => [],
        createConversation,
        restoreConversation,
        send,
      } as unknown as ForgeHostFacade;
      await expect(submitBusMessage(facade, 'hello', options)).resolves.toEqual({
        kind: 'completed',
      });
      expect(createConversation).toHaveBeenCalledTimes(creates);
      expect(restoreConversation).toHaveBeenCalledTimes(restores);
      if ('newChat' in options) expect(createConversation).toHaveBeenCalledWith({ activate: true });
      else expect(restoreConversation).toHaveBeenCalledWith('sender-chat', { activate: false });
      expect(send).toHaveBeenCalledWith(conversationId, 'hello');
    },
  );

  it('mirrors an inbound agent message to the addressed host activity chat', async () => {
    const emitHostActivity = vi.fn();
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        conversations: [{ id: 'sender-chat', title: 'Codex: task', updatedAt: 1 }],
      }),
      recentExchanges: () => [],
      restoreConversation: vi.fn(async () => ({}) as never),
      send: vi.fn(async () => ({ kind: 'completed' as const })),
      emitHostActivity,
    } as unknown as ForgeHostFacade;

    await submitBusMessage(facade, forgeInboundPrompt('codex', 'Please review the patch.'), {
      from: 'codex',
    });

    expect(emitHostActivity).toHaveBeenCalledWith({
      conversationId: 'sender-chat',
      text: 'Forge: codex says:\n\nPlease review the patch.',
    });
  });
});

describe('a --new without --model follows the loaded backend', () => {
  const makeFacade = (activeModel: string | null) => {
    const setConversationModel = vi.fn(async () => {});
    // Like the real host, creating a chat activates it, on the stale default.
    let activeConversationId = 'visible';
    const facade = {
      status: () => ({
        activeConversationId,
        conversations: [
          { id: 'visible', title: 'Visible', activeModel },
          { id: 'new-chat', title: 'New', activeModel: 'stale-default' },
        ],
      }),
      recentExchanges: () => [],
      createConversation: vi.fn(async () => {
        activeConversationId = 'new-chat';
        return { id: 'new-chat' };
      }),
      restoreConversation: vi.fn(async () => ({})),
      setConversationModel,
      send: vi.fn(async () => ({ kind: 'completed' as const })),
    } as unknown as ForgeHostFacade;
    return { facade, setConversationModel };
  };

  it('opens a --new chat on the active conversation\'s model when no --model is given', async () => {
    const { facade, setConversationModel } = makeFacade('tensor-vision');
    await submitBusMessage(facade, 'hello', { from: 'codex', newChat: true });
    expect(setConversationModel).toHaveBeenCalledWith('new-chat', 'tensor-vision');
  });

  it('leaves a --new chat on the default when the active conversation has no model', async () => {
    const { facade, setConversationModel } = makeFacade(null);
    await submitBusMessage(facade, 'hello', { from: 'codex', newChat: true });
    expect(setConversationModel).not.toHaveBeenCalled();
  });
});

describe('busModelIds', () => {
  it('accepts each model and every model@profile it offers', () => {
    const config = {
      models: [{ name: 'qwen', profiles: ['main'] }, { name: 'gemma' }],
      profiles: { main: {}, fast: {} },
    } as unknown as ForgeConfig;
    expect(busModelIds(config)).toEqual(['qwen', 'qwen@main', 'gemma', 'gemma@main', 'gemma@fast']);
  });

  it('accepts alias keys', () => {
    const config = {
      models: [{ name: 'qwen-vision' }],
      profiles: {},
      aliases: { qwen: 'qwen-vision' },
    } as unknown as ForgeConfig;
    expect(busModelIds(config)).toEqual(['qwen-vision', 'qwen']);
  });
});
