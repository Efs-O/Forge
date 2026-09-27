import { describe, expect, it, vi } from 'vitest';
import { busModelIds, submitBusMessage } from '../../src/vscode/agentMessagingSetup';
import { forgeInboundPrompt } from '../../src/agentBus/busContent';
import type { ForgeConfig } from '../../src/config/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

describe('agent bus conversation targeting', () => {
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
