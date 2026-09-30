/**
 * The contact-prompt capacity gate.
 *
 * A contact prompt must run on a model slot that is already loaded and ready,
 * and it must not allow PromptRun to cold-start or evict a model. The gate owns
 * the reservation counter so that two contact batches cannot both observe the
 * same free slot: the reservation is taken synchronously with the capacity
 * decision, before the async acquire.
 *
 * Extracted from `AgentLoop` (pure move — no behaviour change). The loop keeps
 * a thin `runContactPrompt`/`cancelContactPrompts` delegate so existing callers
 * (the sidebar facade) are unaffected.
 */

import type { ConversationRuntime } from './sessionTypes';
import type { TurnServices } from './turnServices';
import { resolveRequestModel } from '../config/ConfigResolver';
import { createContactWebTools } from '../tools/contactWebTools';
import { runPromptToMarkdown } from './PromptRun';

/**
 * The slice of `AgentLoop` the gate needs. The reservation counter lives here
 * (not on the loop) so the gate is self-contained; the loop hands it the
 * streaming/conversation/prompt-controller state it must consult.
 */
export interface ContactPromptDeps {
  services: TurnServices;
  /** Ids of conversations currently streaming a turn. */
  streamingIds: () => ReadonlySet<string>;
  /**
   * Returns the current conversation lookup. A getter, not a value: the lookup
   * is wired after construction, so capturing it at gate-creation time would
   * freeze it at `null`.
   */
  conversationLookup: () => ((id: string) => ConversationRuntime | undefined) | null;
  /** Count of out-of-band prompt controllers NOT owned by the contact prompt. */
  ownerPromptRunCount: () => number;
  /** Abort the contact-owned prompt runs (the `__forge_contact__` owner). */
  abortContactRuns: () => void;
}

export class ContactPromptGate {
  private reservations = 0;

  constructor(private readonly deps: ContactPromptDeps) {}

  /**
   * Runs the contact-only prompt without allowing PromptRun to cold-start or
   * evict a model. The reservation is synchronous with the capacity decision,
   * so two contact batches cannot both observe the same free slot.
   */
  async run(text: string, systemPromptText: string, options?: { web?: boolean }): Promise<string> {
    const config = this.deps.services.getConfig();
    if (!config.active_model) throw new Error('Forge contact model is unavailable.');
    const fallbackModel = config.active_model;
    const target = resolveRequestModel(config, fallbackModel).name;
    if (
      !this.deps.services.pool.isLoaded(target) ||
      !this.deps.services.pool.isModelReady(target)
    ) {
      throw new Error('Forge contact model is unavailable.');
    }
    const activeModels = [...this.deps.streamingIds()].map(
      (id) => this.deps.conversationLookup()?.(id)?.active_model ?? fallbackModel,
    );
    if (activeModels.some((model) => resolveRequestModel(config, model).name !== target)) {
      throw new Error('Forge contact model is unavailable.');
    }
    if (this.deps.ownerPromptRunCount() > 0) throw new Error('Forge contact model is unavailable.');
    const capacity = this.deps.services.pool.parallelCapacity(target);
    const occupied = activeModels.length + this.reservations;
    if (occupied >= capacity) throw new Error('Forge contact model is unavailable.');
    this.reservations += 1;
    let hold;
    try {
      hold = await this.deps.services.pool.acquireForDelegation(target, target);
      if (!hold.backend.isReady()) throw new Error('Forge contact model is unavailable.');
      const web = options?.web
        ? createContactWebTools(this.deps.services.toolRegistry, config)
        : undefined;
      return await runPromptToMarkdown(this.deps.services, text, '__forge_contact__', {
        modelName: target,
        systemPromptText,
        outputTokens: 1_024,
        alwaysStripThinking: true,
        backend: hold.backend,
        ...(web
          ? {
              contactTools: web.definitions,
              dispatchContactTool: web.dispatch,
              maxContactToolRounds: 3,
            }
          : {}),
      });
    } finally {
      hold?.release();
      this.reservations -= 1;
    }
  }

  /** Cancel any in-flight contact prompt runs. */
  cancel(): void {
    this.deps.abortContactRuns();
  }
}
