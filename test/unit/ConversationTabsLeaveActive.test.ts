import { describe, expect, it, vi } from 'vitest';
import { ConversationTabs, type ConversationTabsDeps } from '../../src/sidebar/ConversationTabs';
import type { ForgeConfig } from '../../src/config/types';
import type { SidebarRuntime } from '../../src/sidebar/sessionTypes';
import {
  isConversationEvictable,
  type ConversationEvictionSignals,
} from '../../src/sidebar/evictionGate';

const idleSignals: ConversationEvictionSignals = {
  streaming: false,
  activeRequestChain: false,
  workerChatActive: false,
  unattended: false,
  pendingApprovalActive: false,
  pendingApprovalQueued: false,
  pendingQuestion: false,
  unattributedRequest: false,
  hostQueue: false,
  webviewQueue: false,
  webviewDraft: false,
  beforeWebviewQueueReport: false,
  beforeWebviewDraftReport: false,
  remoteRuntimeUnavailable: false,
  remoteBinding: false,
  remoteIntakeQueue: false,
};

function initialSidebar(ids: string[], messages = true): SidebarRuntime {
  return {
    activeConversationId: ids[0]!,
    conversations: ids.map((id) => ({
      id,
      title: id,
      createdAt: 1,
      updatedAt: 1,
      messages: messages ? [{ role: 'user', content: `Message from ${id}` }] : [],
    })),
    history: [],
  };
}

function harness(options: {
  ids?: string[];
  messages?: boolean;
  blocked?: (id: string) => boolean;
  history?: SidebarRuntime['history'];
} = {}) {
  let state = initialSidebar(options.ids ?? ['tab0', 'tab1'], options.messages ?? true);
  state.history = options.history ?? [];
  const setSidebar = vi.fn((next: SidebarRuntime) => {
    state = next;
  });
  const persistSession = vi.fn();
  const postSessionSync = vi.fn();
  const refreshUi = vi.fn();
  const stopStreamingIfNeeded = vi.fn(async () => {});
  const disposeConversation = vi.fn(async () => {});
  const reset = vi.fn();
  let clock = 10;
  const markActivity = vi.fn((id: string) => {
    state = {
      ...state,
      conversations: state.conversations.map((conversation) =>
        conversation.id === id ? { ...conversation, retention_activity_at: ++clock } : conversation,
      ),
    };
  });
  const retention = {
    markActivity,
    isExpired: () => false,
    isEnabled: () => true,
    refresh: vi.fn(),
  };
  const deps = {
    isStreaming: () => false,
    getConfig: () => ({ active_model: 'model' }) as ForgeConfig,
    getSidebar: () => state,
    setSidebar,
    setActiveModel: vi.fn(),
    persistSession,
    postModels: vi.fn(),
    postSessionSync,
    pool: { release: vi.fn(), isLoaded: () => false },
    agentLoop: { stopStreamingIfNeeded, disposeConversation },
    requestChains: { invalidateConversation: vi.fn() },
    checkpoints: { canUndo: () => false },
    failureTracker: { reset },
    events: {},
    post: vi.fn(),
    baseOf: (id: string | null | undefined) => id ?? null,
    refreshUi,
    isConversationEvictable: (id: string) => !(options.blocked?.(id) ?? false),
    evictionBlockers: () => [],
    isConversationDrafted: () => false,
    retention,
    persistSidebar: async () => true,
  } as unknown as ConversationTabsDeps;
  return {
    tabs: new ConversationTabs(deps),
    getState: () => state,
    setSidebar,
    persistSession,
    postSessionSync,
    refreshUi,
    stopStreamingIfNeeded,
    disposeConversation,
    markActivity,
  };
}

describe('ConversationTabs leaving the active chat', () => {
  it('keeps the previous chat open when creating a conversation and gives it a fresh grace period', () => {
    const h = harness();

    const created = h.tabs.create();

    expect(created).toBeDefined();
    expect(h.getState().history).toEqual([]);
    expect(h.getState().conversations.map((chat) => chat.id)).toContain('tab0');
    expect(h.getState().conversations.find((chat) => chat.id === 'tab0')?.retention_activity_at).toBe(11);
    expect(h.getState().activeConversationId).toBe(created?.id);
  });

  it('keeps both chats open and resets activity on switch away and back', () => {
    const h = harness();

    h.tabs.switch('tab1');

    expect(h.getState().history).toEqual([]);
    expect(h.getState().conversations.map((chat) => chat.id)).toEqual(['tab0', 'tab1']);
    expect(h.getState().activeConversationId).toBe('tab1');
    expect(h.getState().conversations.find((chat) => chat.id === 'tab0')?.retention_activity_at).toBe(11);
    expect(h.getState().conversations.find((chat) => chat.id === 'tab1')?.retention_activity_at).toBe(12);
    expect(h.refreshUi).toHaveBeenCalledWith({ pointerOnly: true });
  });

  it('keeps the previous chat open when restoring history', () => {
    const h = harness({
      history: [{ id: 'restored', title: 'Restored', createdAt: 0, updatedAt: 5, messages: [] }],
    });

    const restored = h.tabs.restore('restored');

    expect(restored?.id).toBe('restored');
    expect(h.getState().history.map((chat) => chat.id)).not.toContain('tab0');
    expect(h.getState().conversations.map((chat) => chat.id)).toContain('tab0');
    expect(h.getState().conversations.find((chat) => chat.id === 'tab0')?.retention_activity_at).toBe(11);
    expect(h.getState().history.map((chat) => chat.id)).not.toContain('restored');
    expect(h.getState().activeConversationId).toBe('restored');
  });

  it.each([
    ['streaming', { streaming: true }],
    ['waiting on an approval', { pendingApprovalActive: true }],
    ['bound to a remote chat', { remoteBinding: true }],
  ] as const)('leaves a chat %s open when the eviction gate pins it', (_label, signal) => {
    const h = harness({
      blocked: (id) => id === 'tab0' && !isConversationEvictable({ ...idleSignals, ...signal }),
    });

    h.tabs.switch('tab1');

    expect(h.getState().conversations.map((chat) => chat.id)).toEqual(['tab0', 'tab1']);
    expect(h.getState().history).toEqual([]);
  });

  it.each(['create', 'restore'] as const)(
    'does not move the active chat for a background %s',
    (action) => {
      const h = harness({
        history: [{ id: 'restored', title: 'Restored', createdAt: 0, updatedAt: 5, messages: [] }],
      });

      if (action === 'create') h.tabs.create({ activate: false });
      else h.tabs.restore('restored', { activate: false });

      expect(h.getState().activeConversationId).toBe('tab0');
      expect(h.getState().conversations.map((chat) => chat.id)).toContain('tab0');
      expect(h.getState().history.map((chat) => chat.id)).not.toContain('tab0');
    },
  );

  it('keeps an empty chat open when creating a new tab', () => {
    const h = harness({ ids: ['tab0'], messages: false });

    const created = h.tabs.create();

    expect(created).toBeDefined();
    expect(h.getState().conversations.map((chat) => chat.id)).toContain('tab0');
    expect(h.getState().conversations).toHaveLength(2);
    expect(h.getState().history).toEqual([]);
  });

  it('does not expose an activation-time startup sweep', () => {
    const h = harness({ ids: ['tab0', 'tab1', 'tab2'] });
    expect((h.tabs as unknown as { sweepIdleConversations?: () => void }).sweepIdleConversations).toBeUndefined();
    expect(h.getState().conversations.map((chat) => chat.id)).toEqual(['tab0', 'tab1', 'tab2']);
  });

  it('restores a moved chat from history', () => {
    const h = harness({ ids: ['tab0'] });
    const movedId = h.getState().activeConversationId;

    h.tabs.create();
    const restored = h.tabs.restore(movedId);

    expect(restored?.id).toBe(movedId);
    expect(h.getState().activeConversationId).toBe(movedId);
    expect(h.getState().conversations.map((chat) => chat.id)).toContain(movedId);
    expect(h.getState().history.map((chat) => chat.id)).not.toContain(movedId);
  });
});
