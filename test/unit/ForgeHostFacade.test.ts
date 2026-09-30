import { describe, expect, it, vi } from 'vitest';
import { SidebarHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { MAX_CONVERSATIONS } from '../../src/sidebar/sessionTypes';

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
  it('create succeeds after eligible eviction, then reports the real reasons', async () => {
    const open = Array.from({ length: MAX_CONVERSATIONS }, (_, i) => conversation(`c${i}`));
    const created = conversation('created');
    const createConversation = vi.fn().mockReturnValueOnce(created).mockReturnValueOnce(undefined);
    const capBlockers = vi.fn(() => ['7 running a turn', '3 waiting on a tool approval', '2 bound to a remote chat']);
    const facade = new SidebarHostFacade({
      createConversation, restoreConversation: () => created, send: vi.fn(), cancel: vi.fn(),
      queueIntent: vi.fn(), addApprovalSink: vi.fn(() => ({ dispose: vi.fn() })),
      addQuestionSink: () => ({ dispose: () => undefined }), answerQuestion: () => false,
      dismissQuestion: () => false, resolveApproval: vi.fn(), getPendingApproval: () => undefined,
      getActiveConversationId: () => 'c0', getOpenConversations: () => open,
      getRequestChains: () => [], getStreamingConversationIds: () => new Set(), capBlockers,
    });
    await expect(facade.createConversation()).resolves.toMatchObject({ id: 'created' });
    const failure = await facade.createConversation().catch((err: unknown) => err as Error);
    // A transport needs the reasons as data, not one sentence it cannot count.
    expect((failure as { atCapReason?: readonly string[] }).atCapReason).toEqual([
      '7 running a turn',
      '3 waiting on a tool approval',
      '2 bound to a remote chat',
    ]);
    expect(failure.message).toContain('7 running a turn');
    expect(failure.message).not.toContain('open chats are busy');
    expect(facade.chatCapBlockers({ activate: true })).toEqual([
      '7 running a turn',
      '3 waiting on a tool approval',
      '2 bound to a remote chat',
    ]);
    expect(capBlockers).toHaveBeenCalledWith({ activate: false });
  });

  it('a restore blocked by the cap carries the reasons too', async () => {
    const open = Array.from({ length: MAX_CONVERSATIONS }, (_, i) => conversation(`c${i}`));
    const facade = new SidebarHostFacade({
      createConversation: () => undefined,
      restoreConversation: () => undefined,
      send: vi.fn(),
      cancel: vi.fn(),
      queueIntent: vi.fn(),
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      dismissQuestion: () => false,
      resolveApproval: () => undefined,
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'c0',
      getOpenConversations: () => open,
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(),
      capBlockers: () => ['12 running a turn'],
    });
    const failure = await facade
      .restoreConversation('archived')
      .catch((err: unknown) => err as { message: string; atCapReason?: readonly string[] });
    expect(failure.atCapReason).toEqual(['12 running a turn']);
  });

  it('a restore of an unknown id is still a plain not-found, not a cap error', async () => {
    const facade = new SidebarHostFacade({
      createConversation: () => undefined,
      restoreConversation: () => undefined,
      send: vi.fn(),
      cancel: vi.fn(),
      queueIntent: vi.fn(),
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      dismissQuestion: () => false,
      resolveApproval: () => undefined,
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'c0',
      getOpenConversations: () => [conversation('c0')],
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(),
      capBlockers: () => [],
    });
    await expect(facade.restoreConversation('nope')).rejects.toThrow(
      'Forge: conversation could not be restored.',
    );
  });
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
      addApprovalSink: vi.fn(() => ({ dispose: vi.fn() })),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      dismissQuestion: () => false,
      resolveApproval: vi.fn(),
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'visible',
      getOpenConversations: () => [created, restored],
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(),
      capBlockers: () => [],
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
      addApprovalSink: vi.fn(() => ({ dispose: vi.fn() })),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      dismissQuestion: () => false,
      resolveApproval: vi.fn(),
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'c1',
      getOpenConversations: () => [conv],
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(['c1']),
      capBlockers: () => [],
    });

    await expect(facade.send('c1', 'hello')).resolves.toEqual({
      kind: 'completed',
      finalText: 'done',
    });
    expect(send).toHaveBeenCalledWith('c1', 'hello', undefined, undefined);
    expect(facade.status()).toMatchObject({
      activeConversationId: 'c1',
      streamingConversationIds: ['c1'],
      conversations: [{ id: 'c1', activeModel: 'local', archived: false }],
    });
  });

  it('reports the host-activity listener count (0 when the sink is not wired)', () => {
    const deps = {
      createConversation: () => conversation('c1'),
      restoreConversation: () => conversation('c1'),
      send: vi.fn(),
      cancel: vi.fn(),
      queueIntent: vi.fn(),
      addApprovalSink: vi.fn(() => ({ dispose: vi.fn() })),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      dismissQuestion: () => false,
      resolveApproval: vi.fn(),
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'c1',
      getOpenConversations: () => [conversation('c1')],
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(),
      capBlockers: () => [],
    };
    // Unwired sink: the count is 0, so the mesh buffer treats it as not ready.
    expect(new SidebarHostFacade(deps).hostActivityListenerCount()).toBe(0);
    // Wired sink: the count is the transport's, read live on each call.
    let n = 0;
    const facade = new SidebarHostFacade({ ...deps, hostActivityListenerCount: () => n });
    expect(facade.hostActivityListenerCount()).toBe(0);
    n = 1;
    expect(facade.hostActivityListenerCount()).toBe(1);
  });
});
