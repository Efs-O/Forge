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
import { isLocalModel } from '../backend/ModelHeuristics';
import {
  opClearMessages,
  opCloseConversation,
  opNewConversation,
  opSetActiveConversationModel,
  opRestoreConversation,
  opSwitchConversation,
} from './ConversationOps';
import {
  createDefaultSession,
  MAX_CONVERSATIONS,
  saveSidebarSession,
  type ConversationRuntime,
} from './sessionTypes';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface ConversationTabsDeps {
  workspaceState: vscode.Memento;
  /** True while any conversation is streaming — clearing then would race it. */
  isStreaming: () => boolean;
  forgetBudget: (convId: string) => void;
  getConfig: () => ForgeConfig;
  getSidebar: () => SidebarRuntime;
  setSidebar: (next: SidebarRuntime) => void;
  setActiveModel: (name: string | null) => void;
  persistSession: () => void;
  postModels: () => void;
  postSessionSync: () => void;
  pool: IBackendPool;
  agentLoop: AgentLoop;
  checkpoints: CheckpointStack;
  failureTracker: ToolFailureTracker;
  events: SidebarProviderEvents;
  post: (msg: HostToWebview) => void;
  baseOf: (id: string | null | undefined) => string | null;
  /** Republishes models, session, and the context budget after a tab change. */
  refreshUi: () => void;
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
      saveSidebarSession(this.deps.workspaceState, fresh);
      conv = fresh.conversations[0];
    }
    return conv;
  }

  create(): void {
    // Pin the current selection onto the new tab. Left unpinned it tracked the
    // global default, so switching to another tab and back silently re-pointed
    // this one at that tab's model.
    const result = opNewConversation(this.deps.getSidebar(), this.deps.getConfig().active_model);
    if (result.atCap) {
      void vscode.window.showWarningMessage(
        `Forge: maximum ${MAX_CONVERSATIONS} conversations. Close one to add another.`,
      );
      return;
    }
    this.deps.setSidebar(result.sidebar);
    this.deps.failureTracker.reset();
    this.deps.refreshUi();
    log.debug('[ConversationTabs] new conversation tab');
  }

  /** Empties the active conversation without closing its tab. */
  clearActive(): void {
    if (this.deps.isStreaming()) return;
    const conv = this.active();
    opClearMessages(conv);
    this.deps.forgetBudget(conv.id);
    this.deps.failureTracker.reset();
    this.deps.refreshUi();
  }

  /** A model chosen in the picker also re-pins the active conversation, so a
   *  failed CLI model is not silently retried while the header shows another. */
  pinModel(name: string | null): void {
    this.deps.setActiveModel(name);
    opSetActiveConversationModel(this.deps.getSidebar(), name);
    this.deps.persistSession();
    this.deps.postModels();
    this.deps.postSessionSync();
  }

  switch(id: string): void {
    const result = opSwitchConversation(this.deps.getSidebar(), id);
    if (!result) return;
    this.deps.setSidebar(result.sidebar);
    if (result.activeModelOverride) this.deps.setActiveModel(result.activeModelOverride);
    this.deps.failureTracker.reset();
    this.deps.refreshUi();
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

  restore(id: string): void {
    const result = opRestoreConversation(this.deps.getSidebar(), id);
    if ('atCap' in result && result.atCap) {
      void vscode.window.showWarningMessage(
        'Forge: maximum open conversations. Close one tab before reopening history.',
      );
      return;
    }
    if ('notFound' in result) return;
    if (!('ok' in result)) return;
    this.deps.setSidebar(result.sidebar);
    if (result.activeModelOverride) this.deps.setActiveModel(result.activeModelOverride);
    this.deps.failureTracker.reset();
    this.deps.refreshUi();
  }

  /** The closed tab may have been the last user of a model still holding VRAM. */
  private offerUnload(modelName: string): void {
    const config = this.deps.getConfig();
    // Compare on the base model: two tabs on the same GGUF (different @profile)
    // share one loaded backend, so the prompt must key by base (F6).
    const base = this.deps.baseOf(modelName) ?? modelName;
    const modelConfig = config.models.find((m) => m.name === base);
    const otherTabUsesModel = this.deps
      .getSidebar()
      .conversations.some((c) => this.deps.baseOf(c.active_model) === base);
    if (otherTabUsesModel || !isLocalModel(modelConfig)) return;
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
