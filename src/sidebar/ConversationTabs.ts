/**
 * Tab-level conversation actions: switch, close, restore.
 *
 * Split out of `SidebarProvider`. `ConversationOps` owns the pure state
 * transitions; this owns everything that has to happen around them — stopping a
 * turn, disposing checkpoints, republishing the UI, and offering to free VRAM.
 */

import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import type { SidebarRuntime } from './sessionTypes';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { IBackendPool } from '../backend/BackendPool';
import type { ToolFailureTracker } from '../tools/StripTools';
import type { AgentLoop, SidebarProviderEvents } from './AgentLoop';
import type { RequestChainLifecycle } from './RequestChainLifecycle';
import {
  opClearMessages,
  opArchiveLeastRecent,
  opCloseConversation,
  opDeleteConversation,
  opNewConversation,
  opSetActiveConversationModel,
  opSetConversationModel,
  opRenameConversation,
  opRestoreConversation,
  opSwitchConversation,
} from './ConversationOps';
import {
  createDefaultSession,
  deriveTitle,
  chatCapMessage,
  MAX_CONVERSATIONS,
  type ConversationRuntime,
} from './sessionTypes';
import { getLogger } from '../util/logger';
import type { ArchivedSessions } from './ArchivedSessions';
import { persistedToRuntime } from './sessionPersistence';
import { TabModelRelease } from './TabModelRelease';
import { retainLiveMemoryKeys } from './compactionWindow';

const log = getLogger();

export interface ConversationTabsDeps {
  /** True while any conversation is streaming — clearing then would race it. */
  isStreaming: () => boolean;
  getConfig: () => ForgeConfig;
  getSidebar: () => SidebarRuntime;
  setSidebar: (next: SidebarRuntime) => void;
  setActiveModel: (name: string | null) => void;
  persistSession: () => void;
  postModels: () => void;
  postSessionSync: () => void;
  pool: IBackendPool;
  agentLoop: AgentLoop;
  requestChains: RequestChainLifecycle;
  checkpoints: CheckpointStack;
  failureTracker: ToolFailureTracker;
  events: SidebarProviderEvents;
  post: (msg: HostToWebview) => void;
  baseOf: (id: string | null | undefined) => string | null;
  /**
   * Republishes models, session, and the context budget after a tab change.
   *
   * `pointerOnly` says the transcripts are untouched and only the active id
   * moved, so the session can be persisted as a single string instead of a
   * full 16 MB rebuild on the extension host.
   */
  refreshUi: (options?: { pointerOnly?: boolean }) => void;
  isConversationEvictable: (id: string) => boolean;
  /**
   * The labels for what blocks archiving `id`, empty when nothing does.
   * Same source as `isConversationEvictable`, so a refusal names real reasons.
   */
  evictionBlockers: (id: string) => string[];
  archivedSessions?: ArchivedSessions;
  liveMemoryKeys?: () => readonly string[];
}

export class ConversationTabs {
  private readonly release: TabModelRelease;

  constructor(private readonly deps: ConversationTabsDeps) {
    this.release = new TabModelRelease(deps);
  }

  /** The active conversation, healing the session if the id went stale. */
  active(): ConversationRuntime {
    const sidebar = this.deps.getSidebar();
    let conv = sidebar.conversations.find((c) => c.id === sidebar.activeConversationId);
    if (!conv && sidebar.conversations.length > 0) {
      conv = sidebar.conversations[0];
      sidebar.activeConversationId = conv.id;
    }
    if (!conv) {
      const fresh = createDefaultSession();
      this.deps.setSidebar(fresh);
      this.deps.persistSession();
      conv = fresh.conversations[0];
    }
    return conv;
  }

  create(options: { activate?: boolean } = {}): ConversationRuntime | undefined {
    // Pin the current selection onto the new tab. Left unpinned it tracked the
    // global default, so switching to another tab and back silently re-pointed
    // this one at that tab's model.
    let sidebar = this.deps.getSidebar();
    let result = opNewConversation(sidebar, this.deps.getConfig().active_model, options);
    if (result.atCap) {
      // Archive first, then persist the updated open set. Load-time dedupe in
      // sessionPersistence keeps the open copy if a crash splits those writes.
      const archived = this.archiveLeastRecent(sidebar, options);
      if (archived) {
        const evictedId = sidebar.conversations.find(
          (conversation) => !archived.conversations.some((open) => open.id === conversation.id),
        )?.id;
        sidebar = archived;
        this.deps.setSidebar(sidebar);
        if (evictedId) this.disposeEvictedConversation(evictedId);
        result = opNewConversation(sidebar, this.deps.getConfig().active_model, options);
      }
    }
    if (result.atCap) {
      void vscode.window.showWarningMessage(chatCapMessage(this.capBlockers()));
      return undefined;
    }
    this.deps.setSidebar(result.sidebar);
    const created = result.sidebar.conversations.find((conv) => conv.id === result.newId);
    if (options.activate === false) {
      this.deps.persistSession();
      this.deps.postSessionSync();
    } else {
      this.deps.failureTracker.reset(result.newId);
      this.deps.refreshUi();
    }
    log.debug('[ConversationTabs] new conversation tab');
    return created;
  }

  /** Empties the active conversation without closing its tab. */
  clearActive(): void {
    if (this.deps.isStreaming()) return;
    const conv = this.active();
    // opClearMessages also drops the measured context counters, so the token
    // bar and the HalluMeter bridge fall back to 0 rather than describing a
    // transcript that no longer exists.
    opClearMessages(conv);
    this.deps.failureTracker.reset(conv.id);
    this.deps.refreshUi();
  }

  /** A model chosen in the picker also re-pins the active conversation, so a
   *  failed CLI model is not silently retried while the header shows another. */
  async pinModel(name: string | null): Promise<void> {
    const conv = this.active();
    const outgoing = conv.active_model ?? this.deps.getConfig().active_model ?? null;
    this.deps.setActiveModel(name);
    opSetActiveConversationModel(this.deps.getSidebar(), name);
    this.deps.persistSession();
    this.deps.postModels();
    this.deps.postSessionSync();
    // `max_simultaneous_models` is cross-conversation headroom (worker fleet,
    // delegation, a second tab). Swapping the model *within* one tab is not a
    // request for a second resident model: without this, picking a 27B while a
    // 12B was loaded spawned a second llama-server alongside it and OOM'd the
    // GPU, because the pool only evicts once every port is taken.
    if (outgoing) await this.release.releaseIfUnused(outgoing, name, conv.id);
  }

  /** Remote/addressed pin: preserve active sidebar focus and global default. */
  setModelById(id: string, name: string | null): boolean {
    const updated = opSetConversationModel(this.deps.getSidebar(), id, name);
    if (!updated) return false;
    this.deps.persistSession();
    this.deps.postSessionSync();
    return true;
  }

  switch(id: string): void {
    const result = opSwitchConversation(this.deps.getSidebar(), id);
    if (!result) return;
    this.deps.setSidebar(result.sidebar);
    if (result.activeModelOverride) this.deps.setActiveModel(result.activeModelOverride);
    // No failure-tracker reset: a streak belongs to its conversation and
    // survives a switch away and back.
    // A switch moves the active id and nothing else: no transcript, title,
    // counter or pin changes here, so there is nothing for a full save to write.
    this.deps.refreshUi({ pointerOnly: true });
    this.deps.events.onConversationSwitched?.(this.deps.getConfig().active_model ?? null);
  }

  async close(id: string): Promise<void> {
    const conv = this.deps.getSidebar().conversations.find((c) => c.id === id);
    const modelName = conv?.active_model;

    await this.deps.agentLoop.stopStreamingIfNeeded(id);
    await this.deps.agentLoop.disposeConversation(id);
    await this.deps.checkpoints.disposeConversation(id);
    const result = opCloseConversation(this.deps.getSidebar(), id);
    if (!result) return;
    this.deps.setSidebar(result.sidebar);
    this.deps.failureTracker.reset(id);
    // Closing a tab hands focus to another one, which is a change of active
    // conversation like any other: adopt its pinned model instead of leaving
    // the closed tab's selection in place.
    const nextActive = this.deps
      .getSidebar()
      .conversations.find((c) => c.id === result.newActiveId);
    if (nextActive?.active_model) this.deps.setActiveModel(nextActive.active_model);
    this.deps.refreshUi();
    if (modelName) this.release.offerUnload(modelName);
  }

  /** Eviction keeps create/restore synchronous; begin scoped cleanup immediately. */
  private disposeEvictedConversation(id: string): void {
    void (async () => {
      await this.deps.agentLoop.stopStreamingIfNeeded(id);
      await this.deps.agentLoop.disposeConversation(id);
      // The checkpoint stack deliberately SURVIVES an archive. It is keyed by
      // conversationId, and an archived conversation keeps that id for life, so
      // the stack is not garbage — it is the Undo of a chat that is merely out
      // of sight. `restore()` re-posts its Keep/Undo bar; ✕ and Delete still
      // dispose it. Undo re-verifies every fingerprint before writing, so a chat
      // that sat archived while the workspace churned gets a refusal, not
      // corrupt bytes.
      // A closed conversation must not leave a streak behind: its id can never
      // be recorded again, so the entry would simply leak.
      this.deps.failureTracker.reset(id);
    })().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.post({
        type: 'error',
        message: `Could not fully clean up archived chat: ${detail}`,
      });
    });
  }
  async deleteConversation(id: string): Promise<void> {
    let sidebar = this.deps.getSidebar();
    if (!sidebar.history.some((item) => item.id === id)) {
      const row = this.deps.archivedSessions?.list().find((item) => item.id === id);
      if (row)
        sidebar = {
          ...sidebar,
          history: [
            ...sidebar.history,
            {
              id: row.id,
              title: row.title,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              messages: [],
              ...(row.active_model ? { active_model: row.active_model } : {}),
            },
          ],
        };
    }
    const conversation = sidebar.conversations.find((c) => c.id === id);
    const archived = sidebar.history.find((c) => c.id === id);
    const target = conversation ?? archived;
    if (!target) return;

    const choice = await vscode.window.showWarningMessage(
      `Permanently delete "${target.title}"? This conversation cannot be recovered.`,
      { modal: true },
      'Delete',
    );
    if (choice !== 'Delete') return;

    const modelName = conversation?.active_model;
    if (conversation) {
      this.deps.requestChains.invalidateConversation(id);
      await this.deps.agentLoop.stopStreamingIfNeeded(id);
      await this.deps.agentLoop.disposeConversation(id);
      await this.deps.checkpoints.disposeConversation(id);
    }
    const result = opDeleteConversation(sidebar, id);
    if (!('ok' in result)) return;
    this.deps.archivedSessions?.purge(id);
    this.deps.setSidebar(result.sidebar);
    this.deps.failureTracker.reset(id);
    const nextActive = this.deps
      .getSidebar()
      .conversations.find((c) => c.id === result.newActiveId);
    if (nextActive?.active_model) this.deps.setActiveModel(nextActive.active_model);
    this.deps.refreshUi();
    if (modelName) this.release.offerUnload(modelName);
  }

  /**
   * Why no slot could be freed, as counts per reason — empty when a slot can.
   *
   * Aggregated over the open chats from the same signals the gate reads, so the
   * sentence cannot drift from the rule. A background open (`activate: false`)
   * excludes the visible chat from the candidate set exactly as
   * `archiveLeastRecent` does, and reports the cap when that leaves nothing.
   */
  capBlockers(options: { activate?: boolean } = {}): string[] {
    const sidebar = this.deps.getSidebar();
    if (sidebar.conversations.length < MAX_CONVERSATIONS) return [];
    const counts = new Map<string, number>();
    for (const conversation of sidebar.conversations) {
      if (options.activate === false && conversation.id === sidebar.activeConversationId) continue;
      const blockers = this.deps.evictionBlockers(conversation.id);
      if (blockers.length === 0) return [];
      for (const label of blockers) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, count]) => `${count} ${label}`);
  }

  /**
   * Retitle a tab or a history row. `deriveTitle` caps the length and collapses
   * whitespace exactly as an auto-derived title is capped, so a hand-typed name
   * cannot blow out the row it renders in. An all-whitespace title is a no-op
   * rather than a reset to the untitled placeholder — the webview treats an empty box as cancel.
   */
  rename(id: string, title: string): void {
    if (!title.trim()) return;
    const sidebar = this.deps.getSidebar();
    if (!sidebar.history.some((item) => item.id === id)) {
      const row = this.deps.archivedSessions?.list().find((item) => item.id === id);
      if (row) {
        this.deps.archivedSessions?.rename(id, deriveTitle(title));
        this.deps.postSessionSync();
        return;
      }
    }
    const result = opRenameConversation(sidebar, id, deriveTitle(title));
    if (!('ok' in result)) return;
    this.deps.archivedSessions?.rename(id, deriveTitle(title));
    this.deps.setSidebar(result.sidebar);
    this.deps.refreshUi();
  }

  /**
   * Frees a slot at cap. A background open (remote, agent messaging) must not
   * archive the chat the user is looking at, which may hold an unsent draft.
   */
  private archiveLeastRecent(
    sidebar: SidebarRuntime,
    options: { activate?: boolean },
  ): SidebarRuntime | undefined {
    return opArchiveLeastRecent(
      sidebar,
      (conversation) =>
        !(options.activate === false && conversation.id === sidebar.activeConversationId) &&
        this.deps.isConversationEvictable(conversation.id),
    );
  }

  restore(id: string, options: { activate?: boolean } = {}): ConversationRuntime | undefined {
    let sidebar = this.deps.getSidebar();
    if (!sidebar.history.some((item) => item.id === id)) {
      const stored = this.deps.archivedSessions?.read(id);
      if (stored)
        sidebar = { ...sidebar, history: [...sidebar.history, persistedToRuntime(stored)] };
    }
    let result = opRestoreConversation(sidebar, id, options);
    if ('atCap' in result && result.atCap) {
      const archived = this.archiveLeastRecent(sidebar, options);
      if (archived) {
        const evictedId = sidebar.conversations.find(
          (conversation) => !archived.conversations.some((open) => open.id === conversation.id),
        )?.id;
        sidebar = archived;
        this.deps.setSidebar(sidebar);
        if (evictedId) this.disposeEvictedConversation(evictedId);
        result = opRestoreConversation(sidebar, id, options);
      }
    }
    if ('atCap' in result && result.atCap) {
      void vscode.window.showWarningMessage(chatCapMessage(this.capBlockers(options)));
      return undefined;
    }
    if ('notFound' in result) return undefined;
    if (!('ok' in result)) return undefined;
    const restored = result.sidebar.conversations.find((conv) => conv.id === id);
    if (restored?.compaction && this.deps.liveMemoryKeys) {
      const retained = retainLiveMemoryKeys(restored.compaction, this.deps.liveMemoryKeys());
      if (retained) restored.compaction = retained;
    }
    this.deps.setSidebar(result.sidebar);
    if (options.activate === false) {
      this.deps.persistSession();
      this.deps.postSessionSync();
    } else {
      if (result.activeModelOverride) this.deps.setActiveModel(result.activeModelOverride);
      this.deps.refreshUi();
    }
    this.revivePendingCheckpoint(id);
    this.deps.archivedSessions?.delete(id);
    return result.sidebar.conversations.find((conv) => conv.id === id);
  }

  /**
   * Bring back the Keep/Undo bar of a chat that was archived with changes
   * still undecided.
   *
   * The stack never went away (see `disposeEvictedConversation`); only its
   * affordance did — the webview drops a closed tab's pending id
   * (`reducer.ts:411-415`). Re-post through the same call a freshly committed
   * turn makes (`ProviderTurn.ts:81-83`), so a restored chat is
   * indistinguishable from one that stayed open. The editor Keep/Undo lenses
   * need nothing: `KeepUndoCodeLensProvider.pendingFiles` is keyed by file path
   * and an archive never cleared it.
   */
  private revivePendingCheckpoint(id: string): void {
    if (!this.deps.checkpoints.canUndo(id)) return;
    this.deps.post({ type: 'checkpointReady', conversationId: id });
  }

  /** `/unloadModel` for one tab — see `TabModelRelease.unloadModelOf`. */
  unloadModelOf(
    convId: string,
  ): Promise<{ model: string; wasLoaded: boolean; serverStopped?: boolean }> {
    return this.release.unloadModelOf(convId);
  }
}
