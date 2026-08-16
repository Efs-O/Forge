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
import { applyCompactionWindow } from './compactionWindow';
import { injectSystemPrompt } from '../llm/SystemPromptInjector';
import { resolveToolPermissions } from '../tools/PermissionResolver';
import { ToolBudget } from '../tools/ToolBudget';
import { extractToolDetail } from './toolSummary';
import { addWorkerDelegationInstructions, buildWorkerCatalog } from '../workers/WorkerPrompts';
import { isTurnCutOffError, runToolCallingLoop } from '../agent/ToolCallingLoop';
import {
  buildTemplateContext,
  canUseThinkingKwargs,
  shouldStripThinking,
} from './turnModelBehavior';

/** Tool rounds per sidebar turn before the loop aborts. Workers have their own,
 *  lower cap in `src/workers/limits.ts`. */
export const MAX_TOOL_ROUNDS = 40;

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
  onContextChanged?: (convId: string, promptChanged: boolean) => void;
  onExactContextTokens?: (convId: string, usedTokens: number) => void;
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
): Promise<void> {
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

  const toolDefinitions = budget.filterDefinitions(ctx.toolRegistry.definitions(allowed));
  const nativeTools = runtimeCaps?.likelySupportsTools !== false;
  if (toolDefinitions.length > 0 && !nativeTools) {
    ctx.warnOnce(
      `${model.name}:tools`,
      `Forge: model "${model.name}" does not appear to have a tool-aware chat template. Forge will use its fallback tool format.`,
    );
  }

  const result = await trackTurnCompletion(ctx.lifecycle, conv.id, () =>
    runToolCallingLoop({
      baseUrl,
      model,
      messages: conv.messages,
      toolDefinitions,
      signal: ctrl.signal,
      maxRounds: MAX_TOOL_ROUNDS,
      nativeTools,
      stripAllTools: useStrip || model.strip_tools === true,
      includeUsage: model.provider === undefined || model.provider === 'llama.cpp',
      canUseThinkingKwargs: thinkingKwargs,
      stripThinkingChannels,
      failureTracker: ctx.failureTracker,
      ...(apiKey ? { apiKey } : {}),
      prepareMessages: (messages) => {
        // Compaction shrinks what the MODEL sees, never the stored transcript.
        // The loop hands us a copy and re-runs this every round, so the window
        // holds for the whole turn without touching conv.messages.
        const windowed = applyCompactionWindow(messages, conv.compaction);
        const injected = injectSystemPrompt(
          windowed,
          ctx.templateEngine,
          buildTemplateContext(config, ctx.forgeLoader, activeFile),
          model.system_prompt,
          model.system_prompt_mode,
        );
        const delegateEnabled = allowed.has('delegate');
        const catalog = delegateEnabled
          ? buildWorkerCatalog(config, allowed.has('cloud-worker'))
          : undefined;
        return addWorkerDelegationInstructions(injected, delegateEnabled, catalog);
      },
      dispatchToolCalls: async (toolCalls, messages) => {
        for (const call of toolCalls) {
          const detail = extractToolDetail(call.function.arguments);
          postC({
            type: 'toolActivity',
            toolName: call.function.name,
            ...(detail ? { detail } : {}),
          });
        }
        await ctx.toolDispatch.dispatch(
          toolCalls,
          allowed,
          messages,
          conv.id,
          ctrl.signal,
          undefined,
          checkpoint,
          model.name,
          budget,
        );
        // A round of file reads and search results can add tens of thousands of
        // tokens. Report it now rather than at the end of the turn.
        ctx.onContextChanged?.(conv.id, true);
      },
      onToken: (text) => postC({ type: 'token', text }),
      onReasoning: (text) => postC({ type: 'reasoningToken', text }),
      onDone: (finishReason) => {
        postC({ type: 'done', finishReason });
        // The completed request's exact count remains the most faithful
        // counterpart to llama-server's prompt-eval number. The final response
        // itself becomes input only on the next request.
        ctx.onContextChanged?.(conv.id, false);
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
        if (model.provider !== undefined && model.provider !== 'llama.cpp') return;
        ctx.onExactContextTokens?.(conv.id, usage.prompt_tokens);
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
  // Cut off by the output ceiling: the reply stopped mid-thought, so the work
  // is unfinished even though the loop returned normally.
  if (result.finishReason === 'length') {
    ctx.lifecycle.markIncomplete(conv.id, 'the reply was cut off by the output limit');
  }
}
