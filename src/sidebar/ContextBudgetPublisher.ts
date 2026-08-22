/**
 * Publishes how full the model's context window is: the sidebar bar, the
 * HalluMeter bridge file, the 85% warning, and the auto-compact trigger.
 *
 * Split out of `SidebarProvider`. All of it hangs off one number, and all of it
 * has to agree about which conversation and which model that number describes.
 *
 * That number is `reportedContextTokens(conv)` — prompt + completion as the
 * inference server counted them. This used to fall back to a chars-per-token
 * estimate of the transcript whenever an exact figure was missing, which meant
 * the bar, the bridge, and the compaction trigger could all be acting on a
 * guess whose known residual error was the whole system prompt. Before the
 * first response there is no measurement, so `used` is 0 and the bar reads
 * `0 / max`; it is never backfilled with an approximation.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';
import { perSlotContext, reportedContextTokens } from '../util/contextBudget';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import { getLogger } from '../util/logger';

const log = getLogger();

/** Minimum gap between mid-turn context recomputations. */
const CONTEXT_TICK_THROTTLE_MS = 500;

/** Fraction of the window that triggers the manual-compaction warning. */
const WARN_AT = 0.85;

/** Default fraction that triggers auto-compaction when it is enabled. */
const DEFAULT_AUTO_COMPACT_AT = 0.85;

function writeForgeBridge(model: string, usedTokens: number, maxTokens: number): void {
  try {
    const dir = path.join(os.homedir(), '.forge');
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({
      model,
      used_tokens: usedTokens,
      max_tokens: maxTokens,
      timestamp_ms: Date.now(),
    });
    fs.writeFileSync(path.join(dir, 'hallumeter-bridge.json'), payload, 'utf8');
  } catch {
    // non-fatal — HalluMeter will simply show stale/unavailable
  }
}

export interface ContextBudgetDeps {
  getConfig: () => ForgeConfig;
  getSidebar: () => SidebarRuntime;
  post: (msg: HostToWebview) => void;
  /** Strips @profile and expands aliases to the base model name (F6). */
  baseOf: (id: string | null | undefined) => string | null;
  /** Runs the threshold-triggered compaction (and its resume). */
  autoCompact: (conv: ConversationRuntime) => Promise<void>;
  /** Runs a user-accepted `/compact` from the 85% warning. */
  manualCompact: () => void;
}

export class ContextBudgetPublisher {
  private warningShown = false;
  private lastTickAt = 0;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingTickConvId: string | undefined;

  constructor(private readonly deps: ContextBudgetDeps) {}

  /** A new prompt starts a fresh warning cycle. */
  resetWarning(): void {
    this.warningShown = false;
  }

  /** Cancels a pending throttled tick so a disposed provider is not published to. */
  dispose(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = undefined;
    this.pendingTickConvId = undefined;
  }

  /**
   * Recomputes and posts the budget for `conv`.
   *
   * `evaluateThresholds` gates the warning and auto-compact, and is set only
   * where a turn actually added context. Opening or switching a conversation
   * must refresh the numbers without acting on them — otherwise merely visiting
   * a full chat would compact it, and the refresh that follows a compaction
   * could immediately trigger another one.
   */
  publish(conv: ConversationRuntime, evaluateThresholds: boolean): void {
    const config = this.deps.getConfig();
    // The bar renders only the active conversation, and letting a background
    // turn write the bridge would point HalluMeter at a model the user is not
    // looking at. Switching tabs republishes, so the number is refreshed on
    // arrival either way.
    if (conv.id !== this.deps.getSidebar().activeConversationId) return;
    // The model the user is actually talking to lives on the conversation; the
    // config-level active_model is only a fallback default. Reading the config
    // alone measured the budget for the wrong model whenever the two differed —
    // and wrote (or skipped) the HalluMeter bridge on that wrong model's ctx.
    const activeSelection = conv.active_model ?? config.active_model;
    const activeBase = this.deps.baseOf(activeSelection);
    const activeModel = this.resolveModel(config, activeBase);
    // `max` is the PER-SLOT window: --ctx-size is the total and --parallel
    // divides it, so every n_parallel > 1 model used to report several times
    // the context it actually had, here and on the HalluMeter bridge.
    const max = activeModel ? perSlotContext(activeModel, config.llama_server) : 0;
    const used = reportedContextTokens(conv);
    this.deps.post({ type: 'tokenBudget', used, max });
    if (activeSelection && max > 0) {
      // Write the BASE name, not the raw selection: an `@profile` suffix would
      // never match a curve id on HalluMeter's side and would churn its session id.
      writeForgeBridge(activeBase ?? activeSelection, used, max);
    } else if (activeSelection) {
      // Fail loudly: this previously skipped in silence, so a config change that
      // stranded num_ctx took the context warning and the bridge down with it.
      log.warn(
        `token budget unavailable for '${activeSelection}' — no num_ctx on the model or its group(s); context warning and HalluMeter bridge disabled`,
      );
    }
    if (evaluateThresholds) this.evaluateThresholds(config, conv, used, max);
  }

  /**
   * Mid-turn tick, throttled leading+trailing.
   *
   * Called when the server reports usage for a round. `publish` writes the
   * HalluMeter bridge with a synchronous `writeFileSync`, and a round of
   * parallel tool calls can fire this several times in a few milliseconds —
   * doing that on the extension host thread each time would stall the UI it is
   * meant to keep current.
   */
  onTurnContextChanged(convId: string): void {
    const elapsed = Date.now() - this.lastTickAt;
    if (elapsed >= CONTEXT_TICK_THROTTLE_MS) {
      this.lastTickAt = Date.now();
      this.publishFor(convId);
      return;
    }
    this.pendingTickConvId = convId;
    if (this.tickTimer) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      this.lastTickAt = Date.now();
      const pending = this.pendingTickConvId;
      this.pendingTickConvId = undefined;
      if (pending) this.publishFor(pending);
    }, CONTEXT_TICK_THROTTLE_MS - elapsed);
  }

  /**
   * Resolve group inheritance before reading num_ctx: models that take their ctx
   * from a group (`group: llamacpp-qwen3`) have no num_ctx of their own, and
   * reading the raw entry yielded 0 — silently disabling the budget and the
   * HalluMeter bridge for every such model.
   */
  private resolveModel(
    config: ForgeConfig,
    base: string | null,
  ): ReturnType<typeof mergeGroupsIntoModel> | undefined {
    const raw = config.models.find((m) => m.name === base);
    return raw ? mergeGroupsIntoModel(config, raw) : undefined;
  }

  private publishFor(convId: string): void {
    const conv = this.deps.getSidebar().conversations.find((c) => c.id === convId);
    // Mid-turn ticks never evaluate thresholds: /compact refuses to run while
    // streaming, and compacting the transcript the tool loop is iterating would
    // corrupt the turn. Auto-compact stays in the post-turn path.
    if (conv) this.publish(conv, false);
  }

  private evaluateThresholds(
    config: ForgeConfig,
    conv: ConversationRuntime,
    used: number,
    max: number,
  ): void {
    if (max <= 0) return;
    const fraction = used / max;
    // Opt-in automatic compaction. Only reached post-turn, so compaction's
    // not-while-streaming guard is already satisfied. It is non-destructive —
    // the transcript is kept, only the model's window shrinks.
    const auto = config.auto_compact;
    if (auto?.enabled === true && fraction >= (auto.at ?? DEFAULT_AUTO_COMPACT_AT)) {
      log.info(`[auto-compact] context at ${Math.round(fraction * 100)}% — compacting`);
      void this.deps.autoCompact(conv);
      return;
    }
    if (fraction >= WARN_AT && !this.warningShown) {
      this.warningShown = true;
      void vscode.window
        .showWarningMessage(
          'Forge: context window is 85% full — run /compact to keep the agent coherent.',
          'Run /compact',
        )
        .then((choice) => {
          if (choice === 'Run /compact') this.deps.manualCompact();
        });
    }
  }
}
