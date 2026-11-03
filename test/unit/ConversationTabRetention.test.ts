import { describe, expect, it, vi } from 'vitest';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import { archiveExpiredConversation } from '../../src/sidebar/ConversationTabRetention';
import type { SidebarRuntime } from '../../src/sidebar/sessionTypes';

function session(): SidebarRuntime {
  return {
    activeConversationId: 'active',
    conversations: [
      {
        id: 'active',
        title: 'Active',
        createdAt: 1,
        updatedAt: 2,
        retention_activity_at: 2,
        keep_open: false,
        messages: [],
      },
      {
        id: 'expired',
        title: 'Expired',
        createdAt: 1,
        updatedAt: 3,
        retention_activity_at: 3,
        keep_open: false,
        messages: [{ role: 'user', content: 'saved prompt' }],
      },
    ],
    history: [],
  };
}

function harness(options: {
  persist?: (next: SidebarRuntime) => Promise<boolean>;
  persistCurrent?: () => Promise<boolean>;
  isEvictable?: () => boolean;
} = {}) {
  let state = session();
  const posted: HostToWebview[] = [];
  const setSidebar = vi.fn((next: SidebarRuntime) => {
    state = next;
  });
  const persistSession = vi.fn(options.persistCurrent ?? (async () => true));
  const persistSidebar = vi.fn(options.persist ?? (async () => true));
  const disposeEvicted = vi.fn();
  const refreshUi = vi.fn();
  const deps = {
    getSidebar: () => state,
    setSidebar,
    persistSession,
    persistSidebar,
    post: (message: HostToWebview) => posted.push(message),
    isConversationEvictable: options.isEvictable ?? (() => true),
    retention: { isExpired: () => true },
    refreshUi,
  };
  return {
    deps,
    posted,
    setSidebar,
    persistSession,
    persistSidebar,
    disposeEvicted,
    refreshUi,
    getState: () => state,
    archive: () => archiveExpiredConversation(deps, 'expired', 3, disposeEvicted),
  };
}

describe('persistence-checked inactivity archive', () => {
  it('keeps the open record and reports when the durable disposition fails', async () => {
    const h = harness({ persist: async () => false });
    const before = h.getState();

    expect(await h.archive()).toBe(false);

    expect(h.getState()).toBe(before);
    expect(h.setSidebar).not.toHaveBeenCalled();
    expect(h.disposeEvicted).not.toHaveBeenCalled();
    expect(h.posted).toContainEqual(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('It remains open') }),
    );
  });

  it('commits through the existing close operation and preserves retention fields in history', async () => {
    const h = harness();

    expect(await h.archive()).toBe(true);

    expect(h.getState().conversations.map((conversation) => conversation.id)).toEqual(['active']);
    expect(h.getState().history).toContainEqual(
      expect.objectContaining({
        id: 'expired',
        retention_activity_at: 3,
        keep_open: false,
      }),
    );
    expect(h.disposeEvicted).toHaveBeenCalledWith('expired', h.getState());
    expect(h.refreshUi).toHaveBeenCalledWith({ sessionPersisted: true });
  });

  it('cancels a stale expiry when a draft or other blocker arrives during persistence', async () => {
    let allowCommit: (() => void) | undefined;
    let canEvict = true;
    const waiting = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const h = harness({
      isEvictable: () => canEvict,
      persist: async () => {
        await waiting;
        return true;
      },
    });
    const before = h.getState();
    const pending = h.archive();
    canEvict = false;
    allowCommit?.();

    expect(await pending).toBe(false);

    expect(h.getState()).toBe(before);
    expect(h.setSidebar).not.toHaveBeenCalled();
    expect(h.persistSession).toHaveBeenCalledTimes(1);
    expect(h.disposeEvicted).not.toHaveBeenCalled();
    expect(h.posted.at(-1)?.type).toBe('error');
  });

  it('does not archive a pinned or newly active chat even if its old timer wakes', async () => {
    const h = harness();
    h.setSidebar({
      ...h.getState(),
      activeConversationId: 'expired',
      conversations: h.getState().conversations.map((conversation) =>
        conversation.id === 'expired' ? { ...conversation, keep_open: true } : conversation,
      ),
    });

    expect(await h.archive()).toBe(false);
    expect(h.persistSidebar).not.toHaveBeenCalled();
    expect(h.getState().conversations.map((conversation) => conversation.id)).toContain('expired');
  });
});
