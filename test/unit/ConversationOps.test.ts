import { describe, expect, it } from 'vitest';
import {
  opClearMessages,
  opArchiveLeastRecent,
  opDeleteConversation,
  opNewConversation,
  opRenameConversation,
  opRestoreConversation,
  opSetActiveConversationModel,
} from '../../src/sidebar/ConversationOps';
import type { SidebarRuntime } from '../../src/sidebar/sessionTypes';
import { UNTITLED_TITLE } from '../../src/sidebar/sessionTypes';
import {
  evictionBlockers,
  isConversationEvictable,
  remoteEvictionSignals,
  type ConversationEvictionSignals,
} from '../../src/sidebar/evictionGate';

function sidebar(): SidebarRuntime {
  return {
    activeConversationId: 'active',
    conversations: [
      {
        id: 'active',
        title: 'Active',
        createdAt: 1,
        updatedAt: 1,
        active_model: 'claude',
        messages: [],
      },
      {
        id: 'other',
        title: 'Other',
        createdAt: 1,
        updatedAt: 1,
        active_model: 'codex',
        messages: [],
      },
    ],
    history: [],
  };
}

describe('opSetActiveConversationModel', () => {
  it('replaces the model pinned to the active conversation only', () => {
    const state = sidebar();

    opSetActiveConversationModel(state, 'local-model');

    expect(state.conversations[0]?.active_model).toBe('local-model');
    expect(state.conversations[1]?.active_model).toBe('codex');
  });

  it('clears the active conversation override when no model is selected', () => {
    const state = sidebar();

    opSetActiveConversationModel(state, null);

    expect(state.conversations[0]).not.toHaveProperty('active_model');
  });
});

describe('opNewConversation', () => {
  it('pins the supplied default so the tab cannot drift to another tab model', () => {
    const state = sidebar();

    const result = opNewConversation(state, 'codex');

    expect(result.atCap).toBe(false);
    if (result.atCap) return;
    const created = result.sidebar.conversations.find((c) => c.id === result.newId);
    expect(created?.active_model).toBe('codex');
  });

  it('can create without changing the visible active conversation', () => {
    const state = sidebar();
    const activeBefore = state.activeConversationId;
    const result = opNewConversation(state, 'codex', { activate: false });
    if (result.atCap) throw new Error('unexpected cap');
    expect(result.sidebar.activeConversationId).toBe(activeBefore);
    expect(result.newId).not.toBe(activeBefore);
    expect(
      result.sidebar.conversations.find((conv) => conv.id === result.newId)?.active_model,
    ).toBe('codex');
  });

  it('leaves the tab unpinned when there is no default model', () => {
    const state = sidebar();

    const result = opNewConversation(state, null);

    expect(result.atCap).toBe(false);
    if (result.atCap) return;
    const created = result.sidebar.conversations.find((c) => c.id === result.newId);
    expect(created).not.toHaveProperty('active_model');
  });
});

describe('opRestoreConversation', () => {
  it('can restore history without changing the visible active conversation', () => {
    const state = sidebar();
    state.history.push({
      id: 'archived',
      title: 'Archived',
      createdAt: 1,
      updatedAt: 1,
      messages: [{ role: 'user', content: 'remember me' }],
    });
    const result = opRestoreConversation(state, 'archived', { activate: false });
    if (!('ok' in result)) throw new Error('restore failed');
    expect(result.sidebar.activeConversationId).toBe('active');
    expect(result.sidebar.conversations.some((conv) => conv.id === 'archived')).toBe(true);
    expect(result.sidebar.history.some((conv) => conv.id === 'archived')).toBe(false);
  });
});

describe('conversation eviction ledger', () => {
  const clear: ConversationEvictionSignals = {
    streaming: false,
    activeRequestChain: false,
    unattended: false,
    pendingApprovalActive: false,
    pendingApprovalQueued: false,
    pendingQuestion: false,
    unattributedRequest: false,
    hostQueue: false,
    webviewQueue: false,
    beforeWebviewQueueReport: false,
    remoteRuntimeUnavailable: false,
    remoteBinding: false,
    remoteIntakeQueue: false,
  };
  const signals: (keyof ConversationEvictionSignals)[] = [
    'streaming',
    'activeRequestChain',
    'unattended',
    'pendingApprovalActive',
    'pendingApprovalQueued',
    'pendingQuestion',
    'unattributedRequest',
    'hostQueue',
    'webviewQueue',
    'beforeWebviewQueueReport',
    'remoteRuntimeUnavailable',
    'remoteBinding',
    'remoteIntakeQueue',
  ];

  it.each(signals)('%s blocks eviction and selects the next eligible chat', (signal) => {
    const state = sidebar();
    state.conversations = state.conversations.map((conversation, index) => ({
      ...conversation,
      id: `candidate-${index}`,
      updatedAt: index,
    }));
    const blocked = { ...clear, [signal]: true } as ConversationEvictionSignals;
    const archived = opArchiveLeastRecent(state, (conversation) =>
      conversation.id === 'candidate-0'
        ? isConversationEvictable(blocked)
        : isConversationEvictable(clear),
    );
    expect(archived?.conversations.map((conversation) => conversation.id)).toEqual(['candidate-0']);
  });

  it('evicts the least recently active chat when every signal is clear', () => {
    expect(isConversationEvictable(clear)).toBe(true);
    const state = sidebar();
    const archived = opArchiveLeastRecent(state, () => isConversationEvictable(clear));
    expect(archived?.conversations.map((conversation) => conversation.id)).toEqual(['other']);
  });

  it('has no undecided-changes signal, so a chat with un-kept changes is evictable', () => {
    // Archiving keeps the checkpoint stack, so "nobody pressed Keep or Undo"
    // stopped being a reason to refuse. A gate that grew the signal back would
    // pin every chat whose agent wrote files, forever.
    expect(clear).not.toHaveProperty('undecidedChanges');
    expect(evictionBlockers(clear)).toEqual([]);
    const state = sidebar();
    const archived = opArchiveLeastRecent(state, () => isConversationEvictable(clear));
    expect(archived?.conversations).toHaveLength(1);
  });

  it('names one label per blocking signal, and none for a clear chat', () => {
    expect(evictionBlockers({ ...clear, streaming: true })).toEqual(['running a turn']);
    expect(evictionBlockers({ ...clear, pendingApprovalActive: true })).toEqual([
      'waiting on a tool approval',
    ]);
    expect(evictionBlockers({ ...clear, remoteBinding: true })).toEqual(['bound to a remote chat']);
    // An unreadable queue state blocks, and says so, rather than reading as
    // free. In production `hostQueue === undefined` always arrives together
    // with `beforeWebviewQueueReport: true`, so the refusal names both labels.
    expect(evictionBlockers({ ...clear, beforeWebviewQueueReport: true })).toEqual([
      'not yet reporting a queue',
    ]);
    expect(
      evictionBlockers({ ...clear, hostQueue: undefined, beforeWebviewQueueReport: true }),
    ).toEqual(['with messages queued', 'not yet reporting a queue']);
    // Two signals sharing a label collapse to one count, so the sentence does
    // not report the same chat twice.
    expect(evictionBlockers({ ...clear, pendingApprovalActive: true, pendingApprovalQueued: true }))
      .toEqual(['waiting on a tool approval']);
  });

  it('names every signal in the gate, so an added one cannot go unexplained', () => {
    for (const signal of signals) {
      expect(evictionBlockers({ ...clear, [signal]: true } as ConversationEvictionSignals)).not
        .toEqual([]);
    }
  });

  it('reads the remote answer as "blocks": an unbound chat is free, a loading store is not', () => {
    // The runtime answers "does remote state pin this chat?". It was once
    // turned into "is it clear?" and fed in as the blocker, so every chat NOT
    // bound to Telegram was pinned and `--new` refused with 12 of 12 blocked.
    expect(isConversationEvictable({ ...clear, ...remoteEvictionSignals(false) })).toBe(true);
    expect(evictionBlockers({ ...clear, ...remoteEvictionSignals(true) })).toEqual([
      'bound to a remote chat',
      'with remote messages queued',
    ]);
    expect(evictionBlockers({ ...clear, ...remoteEvictionSignals(undefined) })).toEqual([
      'with an unreachable remote runtime',
    ]);
  });
});

describe('opClearMessages', () => {
  it('keeps the pinned model so a cleared tab does not fall back to the global', () => {
    const state = sidebar();
    const conv = state.conversations[0]!;
    conv.messages = [{ role: 'user', content: 'hi' }];

    opClearMessages(conv);

    expect(conv.messages).toEqual([]);
    expect(conv.active_model).toBe('claude');
  });
});

describe('opDeleteConversation', () => {
  it('removes an archived conversation without affecting open tabs', () => {
    const state = sidebar();
    state.history = [
      {
        id: 'old',
        title: 'Old chat',
        createdAt: 1,
        updatedAt: 2,
        messages: [{ role: 'user', content: 'old' }],
      },
    ];

    const result = opDeleteConversation(state, 'old');

    expect(result).toMatchObject({ ok: true });
    if (!('ok' in result)) return;
    expect(result.sidebar.history).toEqual([]);
    expect(result.sidebar.conversations.map((conversation) => conversation.id)).toEqual([
      'active',
      'other',
    ]);
  });

  it('creates a fresh empty chat when the last open conversation is deleted', () => {
    const state = sidebar();
    state.conversations = [state.conversations[0]!];

    const result = opDeleteConversation(state, 'active');

    expect(result).toMatchObject({ ok: true });
    if (!('ok' in result)) return;
    expect(result.sidebar.conversations).toHaveLength(1);
    expect(result.sidebar.conversations[0]?.title).toBe(UNTITLED_TITLE);
    expect(result.sidebar.conversations[0]?.messages).toEqual([]);
    expect(result.sidebar.conversations[0]?.id).not.toBe('active');
    expect(result.sidebar.activeConversationId).toBe(result.sidebar.conversations[0]?.id);
  });
});

describe('opRenameConversation', () => {
  it('renames an archived conversation without restoring it', () => {
    const state = sidebar();
    state.history = [{ id: 'old', title: 'hello man', createdAt: 1, updatedAt: 2, messages: [] }];

    const result = opRenameConversation(state, 'old', 'Background test-suite run');

    expect(result).toMatchObject({ ok: true });
    if (!('ok' in result)) return;
    expect(result.sidebar.history[0]?.title).toBe('Background test-suite run');
  });

  it('leaves updatedAt alone so a rename does not reorder history', () => {
    const state = sidebar();
    state.history = [{ id: 'old', title: 'hello man', createdAt: 1, updatedAt: 2, messages: [] }];

    const result = opRenameConversation(state, 'old', 'Renamed');

    if (!('ok' in result)) throw new Error('expected ok');
    expect(result.sidebar.history[0]?.updatedAt).toBe(2);
  });

  it('renames an open tab and leaves the other tabs untouched', () => {
    const result = opRenameConversation(sidebar(), 'other', 'Renamed tab');

    if (!('ok' in result)) throw new Error('expected ok');
    expect(result.sidebar.conversations.map((c) => c.title)).toEqual(['Active', 'Renamed tab']);
  });

  it('reports notFound for an unknown id', () => {
    expect(opRenameConversation(sidebar(), 'nope', 'x')).toEqual({ notFound: true });
  });
});
