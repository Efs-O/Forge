import { describe, expect, it, vi } from 'vitest';
import { submitBusMessage } from '../../src/vscode/agentMessagingSetup';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

describe('agent bus conversation targeting', () => {
  it.each([
    { options: { from: 'codex' }, conversationId: 'sender-chat', creates: 0, restores: 1 },
    { options: { from: 'codex', newChat: true }, conversationId: 'new-chat', creates: 1, restores: 0 },
  ])('keeps the active conversation unchanged for $options', async ({ options, conversationId, creates, restores }) => {
    const createConversation = vi.fn(async () => ({ id: 'new-chat' } as never));
    const restoreConversation = vi.fn(async () => ({} as never));
    const send = vi.fn(async () => ({ kind: 'completed' as const }));
    const facade = {
      status: () => ({ activeConversationId: 'visible', conversations: [{ id: 'visible', title: 'Visible', updatedAt: 2 }, { id: 'sender-chat', title: 'Codex: task', updatedAt: 1 }] }),
      recentExchanges: () => [],
      createConversation, restoreConversation, send,
    } as unknown as ForgeHostFacade;
    await expect(submitBusMessage(facade, 'hello', options)).resolves.toEqual({ kind: 'completed' });
    expect(createConversation).toHaveBeenCalledTimes(creates);
    expect(restoreConversation).toHaveBeenCalledTimes(restores);
    expect(send).toHaveBeenCalledWith(conversationId, 'hello');
    expect(facade.status().activeConversationId).toBe('visible');
  });
});
