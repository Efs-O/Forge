/**
 * When a tab's model can give its VRAM back: on a model switch, on closing the
 * last tab that used it, and on `/unloadModel` for one tab. Split from
 * `ConversationTabs`, which owns the tab list itself; this owns only the
 * question "does anything else still need this backend?".
 */
import * as vscode from 'vscode';
import { isLocalModel } from '../backend/ModelHeuristics';
import { getLogger } from '../util/logger';
import type { ConversationTabsDeps } from './ConversationTabs';

const log = getLogger();

export type TabModelReleaseDeps = Pick<
  ConversationTabsDeps,
  'getConfig' | 'getSidebar' | 'pool' | 'agentLoop' | 'events' | 'post' | 'baseOf'
>;

export class TabModelRelease {
  constructor(private readonly deps: TabModelReleaseDeps) {}

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
  async releaseIfUnused(outgoing: string, incoming: string | null, convId: string): Promise<void> {
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
      log.warn(`[TabModelRelease] "${base}" still streaming — not freed on model switch`);
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
      log.warn(`[TabModelRelease] could not free "${base}" on model switch: ${message}`);
      this.deps.post({ type: 'error', message: `Still loaded — ${message}` });
      return;
    }
    log.info(`[TabModelRelease] freed "${base}" — switched to ${incoming ?? 'no model'}`);
    this.deps.events.onBackendStopped?.(base);
    this.deps.post({ type: 'backendDown', message: `${base} unloaded.` });
  }

  /**
   * `/unloadModel`: free the model behind ONE tab, leaving every other loaded
   * model alone (`unloadModels` is the stop-everything path). Another tab on
   * the same base loses it too — they share one backend. Throws on a refusal so
   * each surface words the failure itself.
   */
  async unloadModelOf(
    convId: string,
  ): Promise<{ model: string; wasLoaded: boolean; serverStopped?: boolean }> {
    const sidebar = this.deps.getSidebar();
    const conv = sidebar.conversations.find((c) => c.id === convId);
    if (!conv) throw new Error('conversation not found');
    const model = conv.active_model ?? this.deps.getConfig().active_model;
    const base = this.deps.baseOf(model);
    if (!model || !base) throw new Error('this chat has no model selected');
    await this.deps.agentLoop.waitForCancelledTurns();
    const wasLoaded = this.deps.pool.isLoaded(base);
    if (this.streamingHolder(model, convId)) {
      throw new Error(`a turn is still running on "${base}" — stop it first`);
    }
    await this.deps.pool.release(base, true);
    const configured = this.deps.getConfig().models.find((entry) => entry.name === base);
    const serverStopped = !!configured?.unload_path && !!configured.stop_command;
    log.info(`[TabModelRelease] unloaded "${base}" for conversation ${convId}`);
    this.deps.events.onBackendStopped?.(base);
    if (convId === sidebar.activeConversationId) {
      this.deps.post({
        type: 'backendDown',
        message: `${base} unloaded.${serverStopped ? ' Server stopped.' : ''} Send a prompt to load it again.`,
      });
    }
    return { model: base, wasLoaded, ...(serverStopped ? { serverStopped: true } : {}) };
  }

  /** The closed tab may have been the last user of a model still holding VRAM. */
  offerUnload(modelName: string): void {
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
