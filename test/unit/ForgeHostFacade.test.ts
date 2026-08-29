import { describe, expect, it, vi } from 'vitest';
import { SidebarHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

function conversation(id: string): ConversationRuntime {
  return {
    id,
    title: `Conversation ${id}`,
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    active_model: 'local',
  } as ConversationRuntime;
}

describe('SidebarHostFacade', () => {
  it('creates and restores without activation by default', async () => {
    const created = conversation('created');
    const restored = conversation('restored');
    const createConversation = vi.fn(() => created);
    const restoreConversation = vi.fn(() => restored);
    const facade = new SidebarHostFacade({
      createConversation,
      restoreConversation,
      send: vi.fn(),
      cancel: vi.fn(),
      queueIntent: vi.fn(),
      getActiveConversationId: () => 'visible',
      getOpenConversations: () => [created, restored],
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(),
    });

    await facade.createConversation();
    await facade.restoreConversation('restored');

    expect(createConversation).toHaveBeenCalledWith({ activate: false });
    expect(restoreConversation).toHaveBeenCalledWith('restored', { activate: false });
    expect(facade.status().activeConversationId).toBe('visible');
  });

  it('returns the addressed typed outcome and bounded status', async () => {
    const conv = conversation('c1');
    const send = vi.fn(async () => ({ kind: 'completed' as const, finalText: 'done' }));
    const facade = new SidebarHostFacade({
      createConversation: () => conv,
      restoreConversation: () => conv,
      send,
      cancel: vi.fn(),
      queueIntent: vi.fn(),
      getActiveConversationId: () => 'c1',
      getOpenConversations: () => [conv],
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(['c1']),
    });

    await expect(facade.send('c1', 'hello')).resolves.toEqual({
      kind: 'completed',
      finalText: 'done',
    });
    expect(send).toHaveBeenCalledWith('c1', 'hello', undefined);
    expect(facade.status()).toMatchObject({
      activeConversationId: 'c1',
      streamingConversationIds: ['c1'],
      conversations: [{ id: 'c1', activeModel: 'local', archived: false }],
    });
  });
});
