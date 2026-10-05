import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import { ConversationTabs, type ConversationTabsDeps } from '../../src/sidebar/ConversationTabs';
import type { ForgeConfig } from '../../src/config/types';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { SidebarRuntime } from '../../src/sidebar/sessionTypes';
import { MAX_CONVERSATIONS } from '../../src/sidebar/sessionTypes';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function config(): ForgeConfig {
  return {
    models: [
      { name: '12b', provider: 'llama.cpp', gguf_path: '/12b.gguf' },
      { name: '27b', provider: 'llama.cpp', gguf_path: '/27b.gguf' },
      { name: 'grok', provider: 'xai' },
    ],
    active_model: '12b',
    llama_server: { port: 8080 },
    max_simultaneous_models: 4,
  } as ForgeConfig;
}

function sidebar(models: string[]): SidebarRuntime {
  return {
    activeConversationId: 'tab0',
    conversations: models.map((model, i) => ({
      id: `tab${i}`,
      title: `Tab ${i}`,
      createdAt: 1,
      updatedAt: 1,
      active_model: model,
      messages: [],
    })),
    history: [],
  };
}

function harness(
  options: {
    tabs?: string[];
    /** Conversation ids mid-turn when the model is re-picked. */
    streamingIds?: string[];
    /** Whether awaiting cancellation clears them (a Stop still unwinding). */
    cancelClearsStreaming?: boolean;
    loaded?: string[];
    evictable?: boolean;
    /** Real stack instead of the stub, for the checkpoint round-trip tests. */
    checkpoints?: ConversationTabsDeps['checkpoints'];
    /** Labels per conversation id, for the cap message. */
    blockers?: (id: string) => string[];
  } = {},
) {
  let state = sidebar(options.tabs ?? ['12b']);
  const release = vi.fn(async () => {});
  const posted: HostToWebview[] = [];
  const postModels = vi.fn();
  const loaded = new Set(options.loaded ?? ['12b']);
  const streamingIds = new Set(options.streamingIds ?? []);
  const deps = {
    isStreaming: () => streamingIds.size > 0,
    forgetBudget: () => {},
    getConfig: config,
    getSidebar: () => state,
    setSidebar: (next: SidebarRuntime) => {
      state = next;
    },
    setActiveModel: () => {},
    persistSession: () => {},
    postModels,
    postSessionSync: () => {},
    pool: { release, isLoaded: (name: string) => loaded.has(name) },
    agentLoop: {
      stopStreamingIfNeeded: async () => {},
      disposeConversation: async () => {},
      // Stop returns to the webview before the turn unwinds; this is the wait
      // that lets the release see an idle tab instead of a streaming one.
      waitForCancelledTurns: async () => {
        if (options.cancelClearsStreaming) streamingIds.clear();
      },
      getStreamingIds: () => streamingIds,
    },
    requestChains: { invalidateConversation: () => {} },
    checkpoints: options.checkpoints ?? {
      disposeConversation: async () => {},
      canUndo: () => false,
      pendingSnapshots: () => [],
    },
    failureTracker: { reset: () => {} },
    events: {},
    post: (msg: HostToWebview) => posted.push(msg),
    // Base of "name@profile"; every fixture model here is already a base.
    baseOf: (id: string | null | undefined) => (id ? id.split('@')[0] : null),
    refreshUi: () => {},
    isConversationEvictable: () => options.evictable ?? false,
    evictionBlockers: options.blockers ?? (() => (options.evictable ? [] : ['running a turn'])),
  } as unknown as ConversationTabsDeps;
  return { tabs: new ConversationTabs(deps), release, posted, postModels };
}

describe('ConversationTabs capacity', () => {
  it.each(['create', 'restore'] as const)(
    '%s archives the least-recently-active eligible chat at cap',
    async (action) => {
      const entries = Array.from({ length: MAX_CONVERSATIONS }, (_, i) => `tab${i}`);
      const { tabs } = harness({ tabs: entries, evictable: true });
      const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
      const state = deps.getSidebar();
      state.conversations.forEach((conversation, i) => {
        conversation.updatedAt = i;
        conversation.messages = [{ role: 'user', content: `chat ${i}` }];
      });
      if (action === 'restore')
        state.history.push({
          id: 'restored',
          title: 'Restored',
          createdAt: 0,
          updatedAt: 50,
          messages: [],
        });
      const disposeLoop = vi.spyOn(deps.agentLoop, 'disposeConversation');
      const disposeCheckpoints = vi.spyOn(deps.checkpoints, 'disposeConversation');
      const result = action === 'create' ? tabs.create() : tabs.restore('restored');
      expect(result).toBeDefined();
      const updated = deps.getSidebar();
      expect(updated.conversations).toHaveLength(MAX_CONVERSATIONS);
      expect(updated.history.some((conversation) => conversation.id === 'tab0')).toBe(true);
      expect(updated.conversations.some((conversation) => conversation.id === 'tab0')).toBe(false);
      // Eviction is a close: the archived chat's loop state and failure streak
      // go too. Its CHECKPOINT stack deliberately does not — it is keyed by
      // conversationId and an archived chat keeps that id, so the stack is the
      // chat's Undo waiting for it to be reopened.
      await flush();
      expect(disposeLoop).toHaveBeenCalledWith('tab0');
      expect(disposeCheckpoints).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'restore'] as const)(
    'a background %s never archives the chat the user is viewing',
    (action) => {
      const { tabs } = harness({
        tabs: Array.from({ length: MAX_CONVERSATIONS }, (_, i) => `tab${i}`),
        evictable: true,
      });
      const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
      const state = deps.getSidebar();
      state.conversations.forEach((conversation, i) => {
        conversation.updatedAt = i;
        conversation.messages = [{ role: 'user', content: `chat ${i}` }];
      });
      state.history.push({ id: 'restored', title: 'R', createdAt: 0, updatedAt: 50, messages: [] });
      const result =
        action === 'create'
          ? tabs.create({ activate: false })
          : tabs.restore('restored', { activate: false });
      expect(result).toBeDefined();
      const updated = deps.getSidebar();
      expect(updated.activeConversationId).toBe('tab0');
      expect(updated.conversations.some((conversation) => conversation.id === 'tab0')).toBe(true);
      expect(updated.history.some((conversation) => conversation.id === 'tab1')).toBe(true);
    },
  );

  it('surfaces a failed cleanup of the evicted chat instead of swallowing it', async () => {
    const { tabs, posted } = harness({
      tabs: Array.from({ length: MAX_CONVERSATIONS }, (_, i) => `tab${i}`),
      evictable: true,
    });
    const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
    deps.getSidebar().conversations.forEach((conversation, i) => {
      conversation.updatedAt = i;
      conversation.messages = [{ role: 'user', content: `chat ${i}` }];
    });
    vi.spyOn(deps.agentLoop, 'disposeConversation').mockRejectedValue(new Error('locked'));
    expect(tabs.create()).toBeDefined();
    await flush();
    expect(posted).toContainEqual({
      type: 'error',
      message: 'Could not fully clean up archived chat: locked',
    });
  });

  it.each(['create', 'restore'] as const)(
    '%s refuses at cap when no chat is eligible',
    (action) => {
      const { tabs } = harness({
        tabs: Array.from({ length: MAX_CONVERSATIONS }, (_, i) => `tab${i}`),
      });
      const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
      const state = deps.getSidebar();
      if (action === 'restore')
        state.history.push({
          id: 'restored',
          title: 'Restored',
          createdAt: 0,
          updatedAt: 50,
          messages: [],
        });
      const result = action === 'create' ? tabs.create() : tabs.restore('restored');
      expect(result).toBeUndefined();
    },
  );

  it('names the reasons with counts instead of claiming every chat is busy', async () => {
    const messages: string[] = [];
    const warning = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockImplementation((message) => Promise.resolve(messages.push(String(message)) as never));
    try {
      const { tabs } = harness({
        tabs: Array.from({ length: MAX_CONVERSATIONS }, (_, i) => `tab${i}`),
        blockers: (id) =>
          Number(id.slice(3)) < 7
            ? ['running a turn']
            : Number(id.slice(3)) < 10
              ? ['waiting on a tool approval']
              : ['bound to a remote chat'],
      });
      expect(tabs.create()).toBeUndefined();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('7 running a turn');
      expect(messages[0]).toContain('3 waiting on a tool approval');
      expect(messages[0]).toContain('2 bound to a remote chat');
      expect(messages[0]).toContain('Archive one yourself');
      // The old lie: a blanket "busy" that named nothing, plus advice to
      // Keep/Undo changes that no longer block anything.
      expect(messages[0]).not.toContain('open chats are busy');
      expect(messages[0]).not.toContain('Keep/Undo');
    } finally {
      warning.mockRestore();
    }
  });
});

describe('ConversationTabs checkpoint survival', () => {
  let root: string;

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('archiving a chat with undecided changes keeps its stack and its disk dirs', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-evict-checkpoint-'));
    // Two separate roots: the in-memory half covers a file outside the
    // workspace the disk half captures, so the two restores cannot collide on
    // one path's postcondition fingerprint.
    const cliWorkspace = path.join(root, 'cli-workspace');
    const storageRoot = path.join(root, 'checkpoints');
    fs.mkdirSync(cliWorkspace);
    fs.mkdirSync(storageRoot);
    const checkpoints = new CheckpointStack({ storageRoot });
    const file = path.join(root, 'notes.txt');
    const cliFile = path.join(cliWorkspace, 'cli.txt');
    fs.writeFileSync(file, 'before');
    fs.writeFileSync(cliFile, 'before');

    // Both halves of a checkpoint: the in-memory `Buffer` a native tool writes,
    // and the disk capture an external CLI turn writes. Eviction must survive
    // both, so the disk dir is asserted too.
    const session = checkpoints.beginTurn('turn-1', 'tab0');
    const capture = await session.prepareWorkspace(cliWorkspace, new AbortController().signal);
    checkpoints.snapshotBefore(file);
    fs.writeFileSync(file, 'after');
    fs.writeFileSync(cliFile, 'after');
    await capture.finish();
    checkpoints.commitTurn(session);
    expect(checkpoints.canUndo('tab0')).toBe(true);
    const dirsBefore = fs.readdirSync(storageRoot);
    expect(dirsBefore.some((name) => name.startsWith('turn-'))).toBe(true);

    const { tabs } = harness({
      tabs: Array.from({ length: MAX_CONVERSATIONS }, (_, i) => `tab${i}`),
      evictable: true,
      checkpoints,
    });
    const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
    deps.getSidebar().conversations.forEach((conversation, i) => {
      conversation.updatedAt = i;
      conversation.messages = [{ role: 'user', content: `chat ${i}` }];
    });

    expect(tabs.create()).toBeDefined();
    await flush();

    // The archived chat's Undo is intact: still undoable, its recovery data
    // still on disk, and both halves still recoverable.
    expect(checkpoints.canUndo('tab0')).toBe(true);
    expect(fs.readdirSync(storageRoot)).toEqual(dirsBefore);
    const restored = await checkpoints.undo('tab0');
    expect(restored).toContain(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('before');
    expect(fs.readFileSync(cliFile, 'utf8')).toBe('before');
    // Keep/Undo of the last checkpoint cleans up the disk dir, as always.
    expect(fs.readdirSync(storageRoot)).toEqual([]);
  });

  it('restore re-posts the Keep/Undo bar for a chat that still has one', async () => {
    const canUndo = vi.fn((id: string) => id === 'restored');
    const { tabs, posted } = harness({
      checkpoints: {
        disposeConversation: async () => {},
        canUndo,
        pendingSnapshots: () => [],
      } as unknown as ConversationTabsDeps['checkpoints'],
    });
    const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
    deps.getSidebar().history.push({
      id: 'restored',
      title: 'Restored',
      createdAt: 0,
      updatedAt: 50,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(tabs.restore('restored')).toBeDefined();
    expect(posted).toContainEqual({ type: 'checkpointReady', conversationId: 'restored' });
  });

  it('restore posts nothing for a chat with no pending changes', async () => {
    const { tabs, posted } = harness();
    const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
    deps.getSidebar().history.push({
      id: 'restored',
      title: 'Restored',
      createdAt: 0,
      updatedAt: 50,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(tabs.restore('restored')).toBeDefined();
    expect(posted).not.toContainEqual({ type: 'checkpointReady', conversationId: 'restored' });
  });

  it('closing a tab with the ✕ still forfeits the checkpoint', async () => {
    const { tabs } = harness();
    const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
    const dispose = vi.spyOn(deps.checkpoints, 'disposeConversation');
    await tabs.close('tab0');
    expect(dispose).toHaveBeenCalledWith('tab0');
  });

  it('deleting a chat still disposes its checkpoint stack', async () => {
    const confirm = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValue('Delete' as never);
    try {
      const { tabs } = harness();
      const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
      const dispose = vi.spyOn(deps.checkpoints, 'disposeConversation');
      await tabs.deleteConversation('tab0');
      expect(dispose).toHaveBeenCalledWith('tab0');
    } finally {
      confirm.mockRestore();
    }
  });
});

describe('ConversationTabs failure streak', () => {
  it('clears only the closed chat streak when a tab is evicted', async () => {
    // The streak is per conversation, so closing a chat must clear that id and
    // not the shared bucket another tab is still counting in.
    const { tabs } = harness({
      tabs: Array.from({ length: MAX_CONVERSATIONS }, (_, i) => `tab${i}`),
      evictable: true,
    });
    const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
    deps.getSidebar().conversations.forEach((conversation, i) => {
      conversation.updatedAt = i;
      conversation.messages = [{ role: 'user', content: `chat ${i}` }];
    });
    const reset = vi.spyOn(deps.failureTracker, 'reset');

    expect(tabs.create()).toBeDefined();
    await flush();

    expect(reset).toHaveBeenCalledWith('tab0');
    expect(reset).not.toHaveBeenCalledWith(undefined);
  });

  it('clears the active chat streak by its id when the transcript is cleared', () => {
    const { tabs } = harness({ tabs: ['12b', '27b'] });
    const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
    const reset = vi.spyOn(deps.failureTracker, 'reset');

    tabs.clearActive();

    expect(reset).toHaveBeenCalledWith('tab0');
    expect(reset).not.toHaveBeenCalledWith(undefined);
  });

  it('clears the closed chat streak by its id when a tab is closed', async () => {
    const { tabs } = harness({ tabs: ['12b', '27b'] });
    const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
    const reset = vi.spyOn(deps.failureTracker, 'reset');

    await tabs.close('tab1');

    expect(reset).toHaveBeenCalledWith('tab1');
    expect(reset).not.toHaveBeenCalledWith(undefined);
  });

  it('keeps each chat streak across a switch', () => {
    const { tabs } = harness({ tabs: ['12b', '27b'] });
    const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
    const reset = vi.spyOn(deps.failureTracker, 'reset');

    tabs.switch('tab1');

    expect(reset).not.toHaveBeenCalled();
  });
});

describe('ConversationTabs.setModelById', () => {
  it('re-sends the selector only when the pinned chat is the one on screen', () => {
    const { tabs, postModels } = harness({ tabs: ['12b', '12b'] });

    expect(tabs.setModelById('tab1', '27b')).toBe(true);
    expect(postModels).not.toHaveBeenCalled();
    expect(tabs.setModelById('tab0', '27b')).toBe(true);
    expect(postModels).toHaveBeenCalledOnce();
  });
});

describe('ConversationTabs.pinModel VRAM release', () => {
  it('frees the outgoing local model when the tab switches away from it', async () => {
    const { tabs, release, posted } = harness();

    tabs.pinModel('27b');
    await flush();

    // Without this the pool kept the 12B resident and spawned a second
    // llama-server for the 27B, which OOM'd the GPU.
    expect(release).toHaveBeenCalledWith('12b');
    expect(posted).toContainEqual({ type: 'backendDown', message: '12b unloaded.' });
  });

  it('keeps the model loaded while another tab still has it pinned', async () => {
    const { tabs, release } = harness({ tabs: ['12b', '12b'] });

    tabs.pinModel('27b');
    await flush();

    expect(release).not.toHaveBeenCalled();
  });

  it('does not stop a backend mid-stream', async () => {
    const { tabs, release, posted } = harness({ streamingIds: ['tab0'] });

    tabs.pinModel('27b');
    await flush();

    expect(release).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'error',
      message:
        '"12b" stays loaded — a turn is still running on it. Stop that turn and re-pick the ' +
        'model to free its VRAM.',
    });
  });

  it('frees the model after a Stop whose turn is still unwinding', async () => {
    // The reported OOM: Stop, re-pick the model, send. The tab was still marked
    // streaming when the switch arrived, the 12B was never released, and the
    // next prompt spawned a second llama-server next to it.
    const { tabs, release } = harness({ streamingIds: ['tab0'], cancelClearsStreaming: true });

    tabs.pinModel('27b');
    await flush();

    expect(release).toHaveBeenCalledWith('12b');
  });

  it('is not blocked by a turn streaming on a different model in another tab', async () => {
    const { tabs, release } = harness({ tabs: ['12b', '27b'], streamingIds: ['tab1'] });

    tabs.pinModel('grok');
    await flush();

    expect(release).toHaveBeenCalledWith('12b');
  });

  it('ignores cloud models, which hold no VRAM', async () => {
    const { tabs, release } = harness({ tabs: ['grok'], loaded: ['grok'] });

    tabs.pinModel('27b');
    await flush();

    expect(release).not.toHaveBeenCalled();
  });

  it('is a no-op when re-picking the same base model under a different profile', async () => {
    const { tabs, release } = harness({ tabs: ['12b@main'] });

    tabs.pinModel('12b@worker');
    await flush();

    expect(release).not.toHaveBeenCalled();
  });

  it('surfaces a refused release instead of leaving the user guessing', async () => {
    const { tabs, release, posted } = harness();
    release.mockRejectedValueOnce(new Error('an active delegation hold is using it'));

    tabs.pinModel('27b');
    await flush();

    expect(posted).toContainEqual({
      type: 'error',
      message: 'Still loaded — an active delegation hold is using it',
    });
  });

  it('does not offer to unload a model already released by a tab switch', async () => {
    const { tabs, release } = harness({ tabs: ['12b', '27b'], loaded: ['27b'] });

    await tabs.close('tab0');
    await flush();

    // The tab's pinned name remains 12b, but its server has already gone away.
    // Closing it must not produce a stale "still loaded" prompt or release call.
    expect(release).not.toHaveBeenCalled();
  });
});

describe('ConversationTabs.unloadModelOf', () => {
  it("releases only the tab's own model, never the other loaded one", async () => {
    const { tabs, release, posted } = harness({ tabs: ['27b', '12b'], loaded: ['27b', '12b'] });

    // The bug: /unloadModel in the 27b tab stopped the 12b as well.
    await expect(tabs.unloadModelOf('tab0')).resolves.toEqual({ model: '27b', wasLoaded: true });

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('27b', true);
    expect(posted).toContainEqual({
      type: 'backendDown',
      message: '27b unloaded. Send a prompt to load it again.',
    });
  });

  it('reports a model that was not loaded and still checks for a managed server to stop', async () => {
    const { tabs, release } = harness({ tabs: ['27b'], loaded: ['12b'] });

    await expect(tabs.unloadModelOf('tab0')).resolves.toEqual({ model: '27b', wasLoaded: false });
    expect(release).toHaveBeenCalledWith('27b', true);
  });

  it('reports that an explicit Strata unload also stopped its server', async () => {
    const { tabs, release, posted } = harness({ tabs: ['strata'], loaded: ['strata'] });
    const deps = (tabs as unknown as { deps: ConversationTabsDeps }).deps;
    deps.getConfig = () => ({
      ...config(),
      models: [
        ...config().models,
        {
          name: 'strata',
          provider: 'openai-compatible',
          endpoint: 'http://127.0.0.1:8090',
          unload_path: '/unload',
          stop_command: ['stop-strata'],
        },
      ],
    });

    await expect(tabs.unloadModelOf('tab0')).resolves.toEqual({
      model: 'strata',
      wasLoaded: true,
      serverStopped: true,
    });
    expect(release).toHaveBeenCalledWith('strata', true);
    expect(posted).toContainEqual({
      type: 'backendDown',
      message: 'strata unloaded. Server stopped. Send a prompt to load it again.',
    });
  });

  it('refuses while a turn is running on that model', async () => {
    const { tabs, release } = harness({ tabs: ['12b'], streamingIds: ['tab0'] });

    await expect(tabs.unloadModelOf('tab0')).rejects.toThrow('a turn is still running on "12b"');
    expect(release).not.toHaveBeenCalled();
  });

  it('does not post backendDown for a tab that is not active', async () => {
    const { tabs, release, posted } = harness({ tabs: ['27b', '12b'], loaded: ['27b', '12b'] });

    await tabs.unloadModelOf('tab1');

    expect(release).toHaveBeenCalledWith('12b', true);
    expect(posted.some((m) => m.type === 'backendDown')).toBe(false);
  });
});
