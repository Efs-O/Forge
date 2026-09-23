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
import { isLocalModel } from '../backend/ModelHeuristics';
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
  MAX_CONVERSATIONS,
  type ConversationRuntime,
} from './sessionTypes';
import { getLogger } from '../util/logger';
import type { ArchivedSessions } from './ArchivedSessions';
import { persistedToRuntime } from './sessionPersistence';

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
  archivedSessions?: ArchivedSessions;
}

export class ConversationTabs {
  constructor(private readonly deps: ConversationTabsDeps) {}

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
      const archived = opArchiveLeastRecent(sidebar, (conversation) =>
        this.deps.isConversationEvictable(conversation.id),
      );
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
      void vscode.window.showWarningMessage(`Forge: all ${MAX_CONVERSATIONS} open chats are busy.`);
      return undefined;
    }
    this.deps.setSidebar(result.sidebar);
    const created = result.sidebar.conversations.find((conv) => conv.id === result.newId);
    if (options.activate === false) {
      this.deps.persistSession();
      this.deps.postSessionSync();
    } else {
      this.deps.failureTracker.reset();
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
    this.deps.failureTracker.reset();
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
    if (outgoing) await this.releaseIfUnused(outgoing, name, conv.id);
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
    this.deps.failureTracker.reset();
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
    this.deps.failureTracker.reset();
    // Closing a tab hands focus to another one, which is a change of active
    // conversation like any other: adopt its pinned model instead of leaving
    // the closed tab's selection in place.
    const nextActive = this.deps
      .getSidebar()
      .conversations.find((c) => c.id === result.newActiveId);
    if (nextActive?.active_model) this.deps.setActiveModel(nextActive.active_model);
    this.deps.refreshUi();
    if (modelName) this.offerUnload(modelName);
  }

  /** Eviction keeps create/restore synchronous; begin scoped cleanup immediately. */
  private disposeEvictedConversation(id: string): void {
    void (async () => {
      await this.deps.agentLoop.stopStreamingIfNeeded(id);
      await this.deps.agentLoop.disposeConversation(id);
      await this.deps.checkpoints.disposeConversation(id);
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
    this.deps.archivedSessions?.delete(id);
    this.deps.setSidebar(result.sidebar);
    this.deps.failureTracker.reset();
    const nextActive = this.deps
      .getSidebar()
      .conversations.find((c) => c.id === result.newActiveId);
    if (nextActive?.active_model) this.deps.setActiveModel(nextActive.active_model);
    this.deps.refreshUi();
    if (modelName) this.offerUnload(modelName);
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

  restore(id: string, options: { activate?: boolean } = {}): ConversationRuntime | undefined {
    let sidebar = this.deps.getSidebar();
    if (!sidebar.history.some((item) => item.id === id)) {
      const stored = this.deps.archivedSessions?.read(id);
      if (stored)
        sidebar = { ...sidebar, history: [...sidebar.history, persistedToRuntime(stored)] };
    }
    let result = opRestoreConversation(sidebar, id, options);
    if ('atCap' in result && result.atCap) {
      const archived = opArchiveLeastRecent(sidebar, (conversation) =>
        this.deps.isConversationEvictable(conversation.id),
      );
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
      void vscode.window.showWarningMessage(`Forge: all ${MAX_CONVERSATIONS} open chats are busy.`);
      return undefined;
    }
    if ('notFound' in result) return undefined;
    if (!('ok' in result)) return undefined;
    this.deps.setSidebar(result.sidebar);
    if (options.activate === false) {
      this.deps.persistSession();
      this.deps.postSessionSync();
    } else {
      if (result.activeModelOverride) this.deps.setActiveModel(result.activeModelOverride);
      this.deps.failureTracker.reset();
      this.deps.refreshUi();
    }
    this.deps.archivedSessions?.delete(id);
    return result.sidebar.conversations.find((conv) => conv.id === id);
  }

  /**
   * Is a live turn still holding the outgoing backend?
   *
   * Per-conversation, not the pool-wide `isStreaming()`: a turn in another tab
   * on an unrelated model is no reason to strand this one's VRAM. This tab is
   * always a holder while it streams — its `active_model` has already been
   * re-pointed at the incoming model, so it no longer names what its request is
   * actually running on. A tab that pinned no model followed the old global
   * default and is counted as a holder too.
   */
  private streamingHolder(outgoing: string, convId: string): boolean {
    const base = this.deps.baseOf(outgoing) ?? outgoing;
    const conversations = this.deps.getSidebar().conversations;
    for (const id of this.deps.agentLoop.getStreamingIds()) {
      if (id === convId) return true;
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return true;
      if ((this.deps.baseOf(conv.active_model ?? outgoing) ?? outgoing) === base) return true;
    }
    return false;
  }

  /**
   * The base model behind `modelName` if unloading it would free VRAM without
   * taking a model out from under another tab, else null.
   *
   * Keyed by base: two tabs on the same GGUF with different @profile share one
   * loaded backend (F6), so a profile suffix must never look like a second model.
   */
  private unloadCandidate(modelName: string): string | null {
    const base = this.deps.baseOf(modelName) ?? modelName;
    const modelConfig = this.deps.getConfig().models.find((m) => m.name === base);
    if (!isLocalModel(modelConfig)) return null;
    const stillInUse = this.deps
      .getSidebar()
      .conversations.some((c) => this.deps.baseOf(c.active_model) === base);
    return stillInUse ? null : base;
  }

  /** Free the model a tab just switched away from, if nothing else wants it. */
  private async releaseIfUnused(
    outgoing: string,
    incoming: string | null,
    convId: string,
  ): Promise<void> {
    // Stop is fire-and-forget: the abort returns to the webview long before the
    // turn finishes unwinding, so a Stop-then-switch arrived here with the tab
    // still marked streaming and skipped the release entirely — the old
    // llama-server kept its VRAM and the next prompt spawned a second one
    // beside it (OOM, since `max_simultaneous_models` only evicts once every
    // port is taken). Wait for cancelled turns exactly as SendPipeline does.
    await this.deps.agentLoop.waitForCancelledTurns();
    const base = this.unloadCandidate(outgoing);
    if (!base || base === this.deps.baseOf(incoming)) return;
    if (!this.deps.pool.isLoaded(base)) return;
    // A turn in flight is still using the old backend — stopping it mid-stream
    // would kill the generation the user is watching. Say so: the VRAM stays
    // occupied, and the next prompt on the new model will load beside it.
    if (this.streamingHolder(outgoing, convId)) {
      log.warn(`[ConversationTabs] "${base}" still streaming — not freed on model switch`);
      this.deps.post({
        type: 'error',
        message: `"${base}" stays loaded — a turn is still running on it. Stop that turn and re-pick the model to free its VRAM.`,
      });
      return;
    }
    try {
      await this.deps.pool.release(base);
    } catch (err) {
      // Pinned by a live delegation hold. The VRAM stays occupied, which is
      // exactly what the user needs to know if the next load then fails.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[ConversationTabs] could not free "${base}" on model switch: ${message}`);
      this.deps.post({ type: 'error', message: `Still loaded — ${message}` });
      return;
    }
    log.info(`[ConversationTabs] freed "${base}" — switched to ${incoming ?? 'no model'}`);
    this.deps.events.onBackendStopped?.(base);
    this.deps.post({ type: 'backendDown', message: `${base} unloaded.` });
  }

  /**
   * `/unloadModel`: free the model behind ONE tab, leaving every other loaded
   * model alone (`unloadModels` is the stop-everything path). Another tab on
   * the same base loses it too — they share one backend. Throws on a refusal so
   * each surface words the failure itself.
   */
  async unloadModelOf(convId: string): Promise<{ model: string; wasLoaded: boolean }> {
    const sidebar = this.deps.getSidebar();
    const conv = sidebar.conversations.find((c) => c.id === convId);
    if (!conv) throw new Error('conversation not found');
    const model = conv.active_model ?? this.deps.getConfig().active_model;
    const base = this.deps.baseOf(model);
    if (!model || !base) throw new Error('this chat has no model selected');
    await this.deps.agentLoop.waitForCancelledTurns();
    if (!this.deps.pool.isLoaded(base)) return { model: base, wasLoaded: false };
    if (this.streamingHolder(model, convId)) {
      throw new Error(`a turn is still running on "${base}" — stop it first`);
    }
    await this.deps.pool.release(base);
    log.info(`[ConversationTabs] unloaded "${base}" for conversation ${convId}`);
    this.deps.events.onBackendStopped?.(base);
    if (convId === sidebar.activeConversationId) {
      this.deps.post({
        type: 'backendDown',
        message: `${base} unloaded. Send a prompt to load it again.`,
      });
    }
    return { model: base, wasLoaded: true };
  }

  /** The closed tab may have been the last user of a model still holding VRAM. */
  private offerUnload(modelName: string): void {
    const base = this.unloadCandidate(modelName);
    // A model switch may already have released this tab's model before the tab
    // is closed. The tab still remembers its model selection, but that is not
    // evidence that a server is resident; prompting in that state offered a
    // stale "still loaded" action for a model that no longer existed.
    if (!base || !this.deps.pool.isLoaded(base)) return;
    void vscode.window
      .showInformationMessage(
        `"${base}" is still loaded in VRAM. Unload it to free memory?`,
        'Unload Now',
      )
      .then((choice) => {
        if (choice !== 'Unload Now') return;
        void this.deps.pool.release(base).then(() => {
          this.deps.events.onBackendStopped?.(base);
          this.deps.post({ type: 'backendDown', message: `${base} unloaded.` });
        });
      });
  }
}
