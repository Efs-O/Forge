import { describe, expect, it, vi } from 'vitest';
import { SidebarHostFacade } from '../../src/sidebar/ForgeHostFacade';
import {
  createSidebarHostFacade,
  type SidebarFacadeDeps,
} from '../../src/sidebar/sidebarFacadeWiring';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { MAX_CONVERSATIONS } from '../../src/sidebar/sessionTypes';
import { ToolApprovalService } from '../../src/sidebar/ToolApprovalService';
import { chatClankerRecords } from '../../src/sidebar/chatClanker';

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

function clankerFacade(initial: ConversationRuntime[] = []) {
  const conversations = [...initial];
  const posted: unknown[] = [];
  const approval = new ToolApprovalService(
    (message) => posted.push(message),
    () => undefined,
    undefined,
    undefined,
    chatClankerRecords((id) => conversations.find((chat) => chat.id === id)),
  );
  let nextId = 0;
  const create = vi.fn(() => {
    const chat = conversation(`created-${++nextId}`);
    conversations.push(chat);
    return chat;
  });
  const persistSession = vi.fn();
  const postSessionSync = vi.fn();
  const send = vi.fn(async () => ({ kind: 'completed' as const, finalText: 'sent' }));
  const facade = createSidebarHostFacade({
    runtime: {
      tabs: { create },
      send: { send },
      agentLoop: {
        getSessionActiveMs: () => 0,
        getClankerMode: (id: string) => approval.getClankerMode(id),
        setClankerMode: (id: string, on: boolean) => approval.setClankerMode(id, on),
      },
    } as never,
    getSidebar: () => ({ activeConversationId: 'opener', conversations, history: [] }) as never,
    persistSession,
    postSessionSync,
    persistConversation: vi.fn(),
    workspaceRoot: 'N:\\workspace',
  } as unknown as SidebarFacadeDeps);
  return { facade, conversations, approval, posted, create, persistSession, postSessionSync, send };
}

describe('SidebarHostFacade', () => {
  it('create succeeds after eligible eviction, then reports the real reasons', async () => {
    const open = Array.from({ length: MAX_CONVERSATIONS }, (_, i) => conversation(`c${i}`));
    const created = conversation('created');
    const createConversation = vi.fn().mockReturnValueOnce(created).mockReturnValueOnce(undefined);
    const capBlockers = vi.fn(() => [
      '7 running a turn',
      '3 waiting on a tool approval',
      '2 bound to a remote chat',
    ]);
    const facade = new SidebarHostFacade({
      createConversation,
      restoreConversation: () => created,
      send: vi.fn(),
      cancel: vi.fn(),
      queueIntent: vi.fn(),
      addApprovalSink: vi.fn(() => ({ dispose: vi.fn() })),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      answerQuestionStructured: vi.fn(() => true),
      skipQuestion: vi.fn(() => true),
      dismissQuestion: () => false,
      resolveApproval: vi.fn(),
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'c0',
      getOpenConversations: () => open,
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(),
      getModelDemandConversationIds: () => new Set(),
      getSessionActiveMs: () => 0,
      capBlockers,
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
      answerQuestionStructured: () => false,
      skipQuestion: () => false,
      dismissQuestion: () => false,
      resolveApproval: () => undefined,
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'c0',
      getOpenConversations: () => open,
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(),
      getModelDemandConversationIds: () => new Set(),
      getSessionActiveMs: () => 0,
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
      answerQuestionStructured: () => false,
      skipQuestion: () => false,
      dismissQuestion: () => false,
      resolveApproval: () => undefined,
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'c0',
      getOpenConversations: () => [conversation('c0')],
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(),
      getModelDemandConversationIds: () => new Set(),
      getSessionActiveMs: () => 0,
      capBlockers: () => [],
    });
    await expect(facade.restoreConversation('nope')).rejects.toThrow(
      'Forge: conversation could not be restored.',
    );
  });

  it('checks conversation existence before reporting a cap error at 10 open chats', async () => {
    const restore = vi.fn();
    const tabs = {
      hasConversation: vi.fn(() => false),
      capBlockers: vi.fn(() => []),
      restore,
    };
    const facade = createSidebarHostFacade({
      runtime: { tabs } as never,
      getSidebar: () =>
        ({
          activeConversationId: 'c0',
          conversations: Array.from({ length: MAX_CONVERSATIONS }, (_, i) => conversation(`c${i}`)),
          history: [],
        }) as never,
    } as unknown as SidebarFacadeDeps);

    await expect(facade.restoreConversation('nope')).rejects.toThrow(
      'Forge: conversation could not be restored.',
    );
    expect(tabs.hasConversation).toHaveBeenCalledWith('nope');
    expect(restore).not.toHaveBeenCalled();
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
      answerQuestionStructured: vi.fn(() => true),
      skipQuestion: vi.fn(() => true),
      dismissQuestion: () => false,
      resolveApproval: vi.fn(),
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'visible',
      getOpenConversations: () => [created, restored],
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(),
      getModelDemandConversationIds: () => new Set(),
      getSessionActiveMs: () => 0,
      capBlockers: () => [],
    });

    await facade.createConversation();
    await facade.restoreConversation('restored');

    expect(createConversation).toHaveBeenCalledWith({ activate: false });
    expect(restoreConversation).toHaveBeenCalledWith('restored', { activate: false });
    expect(facade.status().activeConversationId).toBe('visible');
  });

  it('forwards a worker opener and persists it before returning the conversation', async () => {
    const created = conversation('worker');
    const create = vi.fn(() => created);
    const persistSession = vi.fn();
    const postSessionSync = vi.fn();
    const facade = createSidebarHostFacade({
      runtime: {
        tabs: { create },
        agentLoop: {
          getSessionActiveMs: () => 0,
          getClankerMode: () => false,
          setClankerMode: vi.fn(),
        },
      } as never,
      getSidebar: () =>
        ({ activeConversationId: 'opener', conversations: [created], history: [] }) as never,
      persistSession,
      postSessionSync,
    } as unknown as SidebarFacadeDeps);

    await facade.createConversation({ activate: false, openedBy: 'opener' });

    expect(create).toHaveBeenCalledWith({ activate: false });
    expect(created.opened_by).toBe('opener');
    expect(persistSession).toHaveBeenCalledOnce();
    expect(postSessionSync).toHaveBeenCalledOnce();
  });

  it('a worker from an armed opener inherits Clanker in one session save', async () => {
    const opener = conversation('opener');
    const state = clankerFacade([opener]);
    state.approval.setClankerMode(opener.id, true);
    state.posted.length = 0;

    const worker = await state.facade.createConversation({ activate: false, openedBy: opener.id });

    expect(state.facade.clankerMode(worker.id)).toBe(true);
    expect(state.posted.filter((item) => (item as { type?: string }).type === 'clankerChanged'))
      .toEqual([{ type: 'clankerChanged', enabled: true, conversationId: worker.id }]);
    expect(state.persistSession).toHaveBeenCalledOnce();
    expect(state.postSessionSync).toHaveBeenCalledOnce();
  });

  it('a worker from an unarmed opener starts with Clanker off', async () => {
    const state = clankerFacade([conversation('opener')]);

    const worker = await state.facade.createConversation({ activate: false, openedBy: 'opener' });

    expect(state.facade.clankerMode(worker.id)).toBe(false);
    expect(state.posted).toEqual([]);
  });

  it('a chat created without an opener starts off even when another chat is armed', async () => {
    const other = conversation('other');
    const state = clankerFacade([other]);
    state.approval.setClankerMode(other.id, true);
    state.posted.length = 0;

    const chat = await state.facade.createConversation();

    expect(state.facade.clankerMode(chat.id)).toBe(false);
    expect(state.posted).toEqual([]);
  });

  it('sending to an existing chat leaves its Clanker mode unchanged', async () => {
    const target = conversation('target');
    const state = clankerFacade([target]);
    state.approval.setClankerMode(target.id, true);
    state.posted.length = 0;

    await state.facade.send(target.id, 'hello');

    expect(state.facade.clankerMode(target.id)).toBe(true);
    expect(state.posted).toEqual([]);
  });

  it('turning the opener off leaves the worker on until its own Clanker is turned off', async () => {
    const opener = conversation('opener');
    const state = clankerFacade([opener]);
    state.approval.setClankerMode(opener.id, true);
    const worker = await state.facade.createConversation({ activate: false, openedBy: opener.id });

    state.facade.setClankerMode(opener.id, false);
    expect(state.facade.clankerMode(worker.id)).toBe(true);
    state.facade.setClankerMode(worker.id, false);
    expect(state.facade.clankerMode(worker.id)).toBe(false);
  });

  it('an inbound new_chat from another window starts with Clanker off', async () => {
    const opener = conversation('opener');
    const state = clankerFacade([opener]);
    state.approval.setClankerMode(opener.id, true);

    const inbound = await state.facade.routeInboundAgent(
      { kind: 'codex', sessionId: '123e4567-e89b-42d3-a456-426614174000' },
      { newChat: true },
    );

    expect(state.facade.clankerMode(inbound.conversationId)).toBe(false);
    expect(state.posted.filter((item) => (item as { type?: string }).type === 'clankerChanged'))
      .toEqual([{ type: 'clankerChanged', enabled: true, conversationId: opener.id }]);
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
      answerQuestionStructured: () => false,
      skipQuestion: () => false,
      dismissQuestion: () => false,
      resolveApproval: vi.fn(),
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'c1',
      getOpenConversations: () => [conv],
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(['c1']),
      getModelDemandConversationIds: () => new Set(['c1']),
      getSessionActiveMs: () => 125_000,
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
      modelDemandConversationIds: ['c1'],
      conversations: [{ id: 'c1', activeModel: 'local', archived: false, activeMs: 125_000 }],
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
      answerQuestionStructured: vi.fn(() => true),
      skipQuestion: vi.fn(() => true),
      dismissQuestion: () => false,
      resolveApproval: vi.fn(),
      getPendingApproval: () => undefined,
      getActiveConversationId: () => 'c1',
      getOpenConversations: () => [conversation('c1')],
      getRequestChains: () => [],
      getStreamingConversationIds: () => new Set(),
      getModelDemandConversationIds: () => new Set(),
      getSessionActiveMs: () => 0,
      capBlockers: () => [],
    };
    // Unwired sink: the count is 0, so the mesh buffer treats it as not ready.
    expect(new SidebarHostFacade(deps).hostActivityListenerCount()).toBe(0);
    const facade = new SidebarHostFacade(deps);
    const answer = { answers: [{ picks: [1], note: 'keep the old schema' }] };
    expect(facade.answerQuestionStructured('q1', answer)).toBe(true);
    expect(deps.answerQuestionStructured).toHaveBeenCalledWith('q1', answer);
    expect(facade.skipQuestion('q1')).toBe(true);
    expect(deps.skipQuestion).toHaveBeenCalledWith('q1');
    // Wired sink: the count is the transport's, read live on each call.
    let n = 0;
    const activityFacade = new SidebarHostFacade({ ...deps, hostActivityListenerCount: () => n });
    expect(activityFacade.hostActivityListenerCount()).toBe(0);
    n = 1;
    expect(activityFacade.hostActivityListenerCount()).toBe(1);
  });
});
