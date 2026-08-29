/**
 * One turn against a model endpoint: capability preflight, request assembly,
 * and the tool-calling loop.
 *
 * Split out of `AgentLoop`, which keeps the turn *routing* (which provider,
 * which backend, which lifecycle transitions). This file owns what is actually
 * sent and what comes back.
 */

import * as vscode from 'vscode';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { HostToWebview } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import type { RuntimeModelCapabilities } from '../backend/ModelCapabilities';
import type { TemplateEngine } from '../llm/TemplateEngine';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { ToolDispatch } from './ToolDispatch';
import type { ToolFailureTracker } from '../tools/StripTools';
import type { TurnLifecycle } from './TurnLifecycle';
import { computeContextBudget, estimateToolTokens, perSlotContext } from '../util/contextBudget';
import { prepareToolResultContext } from '../agent/toolResultContext';
import { supersedeStaleReads } from '../agent/staleReadSupersede';
import { applyCompactionWindow } from './compactionWindow';
import { ageOutImageParts, stripImageParts } from './imageParts';
import { announceMissingImages } from './imageNotices';
import { injectSystemPrompt } from '../llm/SystemPromptInjector';
import { resolveToolPermissions } from '../tools/PermissionResolver';
import { ToolBudget } from '../tools/ToolBudget';
import { deriveStaticCapabilities } from '../config/ConfigResolver';
import { extractToolDetail } from './toolSummary';
import { injectTurnContext, type TurnContextState } from './turnContext';
import { latestPastedTerminalCommand } from './compactionLedger';
import { terminalCommandTracker } from '../tools/TerminalCommandTracker';
import { formatPromptCacheStats, readPromptCacheStats } from '../llm/promptCacheStats';
import { getLogger } from '../util/logger';
import { visionUnavailableMessage } from '../tools/imageTool';
import { videoUnavailableMessage } from '../tools/videoTool';
import {
  isTurnCutOffError,
  ROUND_CAP_INCOMPLETE_PREFIX,
  runToolCallingLoop,
  type ToolCallingLoopResult,
} from '../agent/ToolCallingLoop';
import {
  buildTemplateContext,
  canUseThinkingKwargs,
  shouldStripThinking,
} from './turnModelBehavior';

const log = getLogger();

/** Tools that need an mmproj projector. Gated in two places below; keep in sync. */
const VISION_ONLY_TOOLS = new Set(['view_image', 'view_video']);

function activeTerminalCwd(): string | undefined {
  const cwd = vscode.window.activeTerminal?.shellIntegration?.cwd;
  if (!cwd) return undefined;
  return cwd.scheme === 'file' ? cwd.fsPath : cwd.toString(true);
}

/** Tool rounds per sidebar turn when the model does not set `max_tool_rounds`.
 */
export const MAX_TOOL_ROUNDS = 80;

/** Ceiling on a configured `max_tool_rounds`. The cap's job is to stop a
 *  runaway loop eventually; an unbounded value would remove that guarantee. */
export const MAX_CONFIGURABLE_TOOL_ROUNDS = 400;

/**
 * Rounds this model may spend on one turn.
 *
 * Resolution happens here rather than in the loop because `model` has already
 * been through `resolveRequestModel`, so a group- or profile-level value is
 * merged in by the time it arrives.
 */
export function resolveMaxToolRounds(model: ModelConfig): number {
  const configured = model.max_tool_rounds;
  if (configured === undefined) return MAX_TOOL_ROUNDS;
  return Math.max(1, Math.min(Math.floor(configured), MAX_CONFIGURABLE_TOOL_ROUNDS));
}

export interface ModelTurnContext {
  getConfig: () => ForgeConfig;
  toolRegistry: ToolRegistry;
  toolDispatch: ToolDispatch;
  failureTracker: ToolFailureTracker;
  lifecycle: TurnLifecycle;
  templateEngine?: TemplateEngine;
  forgeLoader?: ForgeInstructionsLoader;
  /** Cached runtime probe of the served model. */
  capabilities: (model: ModelConfig, baseUrl: string) => Promise<RuntimeModelCapabilities>;
  /** Shows a warning at most once per key, for the life of the session. */
  warnOnce: (key: string, message: string) => void;
  onContextChanged?: (convId: string) => void;
  onUsage?: (conv: ConversationRuntime, inputTokens: number, outputTokens: number) => void;
  onTranscriptChanged?: (conv: ConversationRuntime) => void;
}

export interface ModelTurnRequest {
  baseUrl: string;
  conv: ConversationRuntime;
  model: ModelConfig;
  activeFile: string | undefined;
  ctrl: AbortController;
  postC: (msg: HostToWebview) => void;
  apiKey?: string;
  checkpoint?: CheckpointSession;
}

/**
 * Warns about model/config mismatches that change how the request is built.
 * Each is `warnOnce`-keyed: they are properties of the model, so repeating them
 * every turn would be noise.
 */
function warnAboutModel(
  ctx: ModelTurnContext,
  model: ModelConfig,
  config: ForgeConfig,
  runtimeCaps: RuntimeModelCapabilities | undefined,
  thinkingKwargs: boolean,
): void {
  if (
    !thinkingKwargs &&
    (model.think !== undefined || model.sampling?.preserve_thinking !== undefined)
  ) {
    ctx.warnOnce(
      `${model.name}:thinking`,
      `Forge: model "${model.name}" does not appear to support thinking template toggles. Thinking kwargs will be omitted for this request.`,
    );
  }
  if (runtimeCaps?.hasChatTemplate === false) {
    ctx.warnOnce(
      `${model.name}:template`,
      `Forge: model "${model.name}" does not expose a usable chat template. Prompt formatting may be mismatched.`,
    );
  }
  const perSlot = perSlotContext(model, config.llama_server);
  const configuredMaxTokens = model.sampling?.max_tokens;
  if (perSlot > 0 && configuredMaxTokens !== undefined && configuredMaxTokens > perSlot) {
    ctx.warnOnce(
      `${model.name}:max-tokens`,
      `Forge: model "${model.name}" sets max_tokens ${configuredMaxTokens}, above its ${perSlot}-token per-slot context. Forge will cap output at the room actually left in each turn.`,
    );
  }
}

/**
 * Records turns that ended for want of room. `runToolCallingLoop` *throws* on
 * the round cap and on exhausted context, so both have to be caught here —
 * only `finish_reason: length` comes back through a normal return.
 */
async function trackTurnCompletion<T>(
  lifecycle: TurnLifecycle,
  convId: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isTurnCutOffError(err)) lifecycle.markIncomplete(convId, (err as Error).message);
    throw err;
  }
}

export async function runModelTurn(
  ctx: ModelTurnContext,
  { baseUrl, conv, model, activeFile, ctrl, postC, apiKey, checkpoint }: ModelTurnRequest,
): Promise<ToolCallingLoopResult> {
  const config = ctx.getConfig();
  const allowed = resolveToolPermissions(config);
  // One budget per turn — model is already resolveRequestModel()'d
  // (group tools/tool_call_limits merged) by the caller.
  const budget = new ToolBudget(model);
  const useStrip = ctx.failureTracker.shouldStrip();
  const runtimeCaps = await ctx.capabilities(model, baseUrl);
  const thinkingKwargs = canUseThinkingKwargs(model, runtimeCaps);
  const stripThinkingChannels = shouldStripThinking(model, config);
  if (useStrip) {
    void vscode.window.showWarningMessage(
      'Forge: tool calls disabled after repeated failures. Restart chat to re-enable.',
    );
  }
  warnAboutModel(ctx, model, config, runtimeCaps, thinkingKwargs);

  const maxRounds = resolveMaxToolRounds(model);
  const isVisionModel = deriveStaticCapabilities(model).includes('vision');
  // Withholding the definition is not enforcement: the tool stays in the
  // registry and a model that calls it blind would ship base64 to a backend
  // with no projector. Refuse it at dispatch, with the reason.
  const unavailableTools = isVisionModel
    ? undefined
    : new Map([
        ['view_image', visionUnavailableMessage(model.name)],
        ['view_video', videoUnavailableMessage(model.name)],
      ]);
  // Both halves of the gate must list the same tools. Advertising without
  // refusing ships base64 at a projector-less backend; refusing without
  // withholding advertises a tool that always fails.
  const advertisedDefinitions = ctx.toolRegistry
    .definitions(allowed)
    .filter((definition) => isVisionModel || !VISION_ONLY_TOOLS.has(definition.function.name));
  const toolDefinitions = budget.filterDefinitions(advertisedDefinitions);
  const nativeTools = runtimeCaps?.likelySupportsTools !== false;
  if (toolDefinitions.length > 0 && !nativeTools) {
    ctx.warnOnce(
      `${model.name}:tools`,
      `Forge: model "${model.name}" does not appear to have a tool-aware chat template. Forge will use its fallback tool format.`,
    );
  }

  announceMissingImages(conv, model, isVisionModel, { postC, warnOnce: ctx.warnOnce });

  // Layer C is snapshotted HERE, once per turn, not rebuilt per round.
  // `prepareMessages` runs again on every tool round, so reading `conv.plan`
  // live meant an `update_plan` mid-turn rewrote a message sitting just after
  // the system prompt -- the block folds into the last USER message, and on
  // round N that is the request that opened the turn. Measured on a 4-round
  // turn with three update_plan calls: cache reuse fell from 76% to 39%, and
  // two consecutive rounds that grew the prompt by 186 tokens re-evaluated
  // 15401 of them (~20 s of prefill each).
  //
  // The model does not need the block re-rendered to know what it just did:
  // update_plan returns a tool result confirming the write, and the new plan
  // reaches the prompt on the next USER turn, where the prefix is being
  // extended anyway. `items` is copied so a later in-place mutation of
  // conv.plan cannot reach back into this turn's prompt.
  const pastedTerminalCommand = latestPastedTerminalCommand(conv.messages);
  const terminalCommandResult = terminalCommandTracker.latestForConversation(conv.id);
  const terminalCwd =
    pastedTerminalCommand || terminalCommandResult ? activeTerminalCwd() : undefined;
  const turnContext: TurnContextState = {
    activeFile,
    ...(terminalCommandResult
      ? { terminalCommandResult }
      : pastedTerminalCommand
        ? { pastedTerminalCommand }
        : {}),
    ...(terminalCwd ? { activeTerminalCwd: terminalCwd } : {}),
    ...(conv.plan ? { plan: { items: [...conv.plan.items], updatedAt: conv.plan.updatedAt } } : {}),
  };

  const result = await trackTurnCompletion(ctx.lifecycle, conv.id, () =>
    runToolCallingLoop({
      baseUrl,
      model,
      messages: conv.messages,
      toolDefinitions,
      signal: ctrl.signal,
      maxRounds,
      nativeTools,
      stripAllTools: useStrip || model.strip_tools === true,
      includeUsage: true,
      canUseThinkingKwargs: thinkingKwargs,
      stripThinkingChannels,
      failureTracker: ctx.failureTracker,
      ...(apiKey ? { apiKey } : {}),
      prepareMessages: (messages) => {
        // Compaction shrinks what the MODEL sees, never the stored transcript.
        // The loop hands us a copy and re-runs this every round, so the window
        // holds for the whole turn without touching conv.messages.
        const windowed = applyCompactionWindow(messages, conv.compaction);
        // The one place images ever leave the model-facing copy. Aging and the
        // no-vision strip are mutually exclusive: on a projector-less model the
        // `no-vision` note wins, because it explains why the image is missing
        // now rather than implying it can be recovered by re-calling view_image.
        //
        // Runs AFTER the window (no point rewriting messages it drops) and
        // BEFORE injection/excerpting, so the freed tokens reach the budget math.
        const visible = isVisionModel
          ? ageOutImageParts(windowed, model.image_retention_turns)
          : stripImageParts(windowed, {
              reason: 'no-vision',
              modelName: model.name,
            });
        const injected = injectSystemPrompt(
          visible,
          ctx.templateEngine,
          buildTemplateContext(config, ctx.forgeLoader, activeFile),
          model.system_prompt,
          model.system_prompt_mode,
        );
        // Only the model-facing copy is reduced. `conv.messages` remains the
        // full raw transcript for sidebar, persistence, and exact recovery via
        // read_tool_result when an excerpt calls for more detail.
        // Runs BEFORE the excerpting below so the budget sees the freed room:
        // on a turn that would not otherwise fit, the surviving results get
        // excerpted less aggressively.
        // Layer C last, so the volatile block lands as close to the tail as a
        // strict chat template allows. Everything above it -- system prompt and
        // the whole conversation -- stays byte-identical while the active file
        // or the plan changes, which is what keeps the KV cache warm. The state
        // is the turn-start snapshot above, so it is byte-identical across the
        // rounds WITHIN this turn too.
        const withTurnContext = injectTurnContext(injected, turnContext);
        return prepareToolResultContext({
          messages: supersedeStaleReads(withTurnContext),
          toolTokens: estimateToolTokens(toolDefinitions),
          model,
          server: config.llama_server,
        }).messages;
      },
      dispatchToolCalls: async (toolCalls, messages) => {
        for (const call of toolCalls) {
          const detail = extractToolDetail(call.function.arguments);
          postC({
            type: 'toolActivity',
            toolName: call.function.name,
            toolCallId: call.id,
            ...(detail ? { detail } : {}),
          });
        }
        await ctx.toolDispatch.dispatch(
          toolCalls,
          allowed,
          messages,
          conv.id,
          ctrl.signal,
          checkpoint,
          budget,
          (diff) => {
            const displayDiffs = conv.displayDiffs ?? (conv.displayDiffs = []);
            displayDiffs.push(diff);
          },
          unavailableTools,
          // The host stamps updatedAt, never the model: the staleness shown in
          // the injected block would be worthless if its writer could choose
          // it. onTranscriptChanged is what persists and syncs, so the plan is
          // durable the moment the tool returns.
          (items) => {
            conv.plan = { items, updatedAt: Date.now() };
            ctx.onTranscriptChanged?.(conv);
          },
        );
        // The token bar reports measured context, not a projection, so a tool
        // result does not move it — the next round's usage frame does. The
        // tick therefore lives in `onUsage` below.
      },
      onMessagesChanged: () => ctx.onTranscriptChanged?.(conv),
      onToken: (text) => postC({ type: 'token', text }),
      onReasoning: (text) => postC({ type: 'reasoningToken', text }),
      onDone: (finishReason) => {
        postC({ type: 'done', finishReason });
      },
      onRepeatedCall: () =>
        postC({
          type: 'error',
          message:
            'Forge: agent is repeating the same tool call — stopping to avoid a loop. Try rephrasing your request or use /compact if the context is full.',
        }),
      onNativeFallback: () =>
        ctx.warnOnce(
          `${model.name}:native-tool-json`,
          `Forge: llama-server rejected this model's native tool-call JSON. Retrying with Forge's JSON fallback tool format.`,
        ),
      onUsage: (usage) => {
        // The server's own slot counters, covering prompt evaluation and
        // generation including hidden thinking. Every context display reads
        // what this writes, so publish the bar from here: an agentic turn
        // reports usage once per round and the bar stays live mid-turn.
        ctx.onUsage?.(conv, usage.prompt_tokens, usage.completion_tokens);
        ctx.onContextChanged?.(conv.id);
        // How much of the prompt llama-server served from its KV cache. A turn
        // that only grew should sit in the high 90s; a drop to 0 means
        // something rewrote the prompt head. Debug-level and contents-free --
        // this fires on every round of every turn.
        const cache = readPromptCacheStats(usage);
        if (cache) log.debug(formatPromptCacheStats(cache));
      },
      // A status line, not an error: the turn continues and the model is being
      // asked for the same write in chunks.
      onTruncatedToolCall: ({ toolName, approxBytes }) =>
        postC({
          type: 'toolActivity',
          toolName: toolName ?? 'tool call',
          detail: `output cut off after ${approxBytes} bytes — retrying in chunks`,
        }),
      getOutputRoom: (messages) =>
        computeContextBudget({
          messages,
          toolTokens: estimateToolTokens(toolDefinitions),
          model,
          server: config.llama_server,
        }).outputRoom || undefined,
    }),
  );
  // Final publish for the turn. The per-round ticks above are throttled, so
  // the last one may have been coalesced away.
  ctx.onContextChanged?.(conv.id);
  // Cut off by the output ceiling: the reply stopped mid-thought, so the work
  // is unfinished even though the loop returned normally.
  if (result.finishReason === 'length') {
    ctx.lifecycle.markIncomplete(conv.id, 'the reply was cut off by the output limit');
  }
  // Same shape as the `length` case above: the loop returned normally, but the
  // request is unfinished. Marking it is what lets the post-turn resume pick it
  // up — without this the turn simply stopped, and only a manual "continue"
  // restarted it (with a fresh, equally exhaustible budget).
  if (result.hitRoundCap) {
    ctx.lifecycle.markIncomplete(conv.id, `${ROUND_CAP_INCOMPLETE_PREFIX} (${maxRounds})`);
    // Name the knob. Hitting the cap on real work is a budgeting problem the
    // user can fix, and without this the stop looked like an internal failure
    // with no recourse but to retype "continue" for another identical budget.
    postC({
      type: 'notice',
      message:
        `Forge: stopped after ${maxRounds} tool rounds with the task unfinished. ` +
        `Send a smaller step, or raise \`max_tool_rounds\` on "${model.name}" ` +
        `(or its group) if this task legitimately needs more.`,
    });
  }
  return result;
}
