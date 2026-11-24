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
import type { MidTurnDrainResult } from '../agent/MidTurnInbox';
import type { CheckinStage } from '../agent/elapsedTimeNote';
import { createContextTrimState } from '../agent/toolResultContext';
import type { ToolDispatch } from './ToolDispatch';
import { stripDecision, type ToolFailureTracker } from '../tools/StripTools';
import type { TurnLifecycle } from './TurnLifecycle';
import { createOutputBudgetTracker } from '../util/contextBudget';
import { announceMissingImages } from './imageNotices';
import { prepareModelTurnMessages } from './prepareModelTurnMessages';
import { resolveToolPermissions } from '../tools/PermissionResolver';
import { ToolBudget } from '../tools/ToolBudget';
import { setSchemasInResult, setTextCallCatalog } from '../tools/lazyToolGroups';
import { deriveStaticCapabilities } from '../config/ConfigResolver';
import { applyToolCalls } from './transcriptMutations';
import { mirrorLiveSessionAnswers } from './liveSessionMirror';
import { extractToolDetail, activityToolName } from './toolSummary';
import { snapshotTurnPromptHead } from './turnPromptSnapshot';
import { buildTurnStreamHandlers } from './turnStreamHandlers';
import { pinCodingTips } from './codingTipsPin';
import {
  assertTextCallsReadable,
  buildTextCallDefinitions,
  buildToolDefinitions,
} from './turnToolDefinitions';
import { toolOutputLimits } from '../tools/toolOutputLimits';
import { buildVisionRefusals } from './visionGate';
import { unattendedConversations, withUnattendedRefusals } from './unattendedConversations';
import { runToolCallingLoop, type ToolCallingLoopResult } from '../agent/ToolCallingLoop';
import { publishTurnOutcome, trackTurnCompletion } from './turnOutcomeReporting';
import { canUseThinkingKwargs, isProjectRoot, shouldStripThinking } from './turnModelBehavior';
import { warnAboutModel } from './modelMismatchWarnings';
import type { AgentProgressEvent } from './AgentProgress';
import type { LiveStreamMeter } from './LiveStreamMeter';
import { writeChunkLimit } from '../tools/writeChunking';
import type { RequestOfferedListener } from '../sessions/requestFingerprint';
import type { RequestCapture } from '../sessions/requestStats';
import { isMutatingTool, type QuestionWaitRunner } from '../tools/toolContract';
import { startStrataBusyWarning } from './strataBusyWarning';

/** Tool rounds per sidebar turn when the model does not set `max_tool_rounds`. */
export const MAX_TOOL_ROUNDS = 1000;

/** Ceiling on a configured `max_tool_rounds`. The cap's job is to stop a
 *  runaway loop eventually; an unbounded value would remove that guarantee. */
export const MAX_CONFIGURABLE_TOOL_ROUNDS = 1000;

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
  onToolsOffered?: RequestOfferedListener;
  /** Tool names a round's text gave as calls, and which of them were unlisted. */
  onTextToolCalls?: (convId: string, names: readonly string[], unlisted: readonly string[]) => void;
  onRequestStats?: (conversationId: string, capture: RequestCapture) => void;
  onTranscriptChanged?: (conv: ConversationRuntime) => void;
  emitAgentProgress: (event: AgentProgressEvent) => void;
  streamMeter?: LiveStreamMeter;
  /** Remote chats bound to a conversation. Absent when no transport is live. */
  remoteReach?: (conversationId: string) => number;
  /** Reads the current workspace memory index for a new chat's first turn. */
  listMemoryLines?: () => readonly string[];
  compactMidTurn?: (conv: ConversationRuntime, request: { exhausted: boolean }) => Promise<boolean>;
  drainTells?: (conversationId: string) => Promise<MidTurnDrainResult>;
  onTellArrived?: (conversationId: string, callback: () => void) => () => void;
  /** Routes `set_checkin` to this conversation's clock. Absent when unwired. */
  setCheckin?: (
    conversationId: string,
    minutes: number,
    byThen: CheckinStage,
  ) => { dueAt: number } | undefined;
}

export interface ModelTurnRequest {
  /** Resolved per round, never captured: see ToolCallingLoopOptions. */
  resolveBaseUrl: () => Promise<string>;
  conv: ConversationRuntime;
  model: ModelConfig;
  activeFile: string | undefined;
  ctrl: AbortController;
  postC: (msg: HostToWebview) => void;
  apiKey?: string;
  getApiKey?: () => string | undefined;
  checkpoint?: CheckpointSession;
  withQuestionWait?: QuestionWaitRunner;
}

export async function runModelTurn(
  ctx: ModelTurnContext,
  {
    resolveBaseUrl,
    conv,
    model,
    activeFile,
    ctrl,
    postC,
    apiKey,
    getApiKey,
    checkpoint,
    withQuestionWait,
  }: ModelTurnRequest,
): Promise<ToolCallingLoopResult> {
  const config = ctx.getConfig();
  startStrataBusyWarning(model, conv.id, ctx.lifecycle.streamingIds(), postC, ctrl.signal);
  // A cancelled request never reports usage; its leftover estimate must not
  // carry into this turn's first request.
  ctx.streamMeter?.reset(conv.id);
  const allowed = resolveToolPermissions(config);
  // One budget per turn — model is already resolveRequestModel()'d
  // (group tools/tool_call_limits merged) by the caller.
  const budget = new ToolBudget(model);
  const stripChoice = stripDecision(ctx.failureTracker, conv.id, model);
  // One probe per turn is right — capabilities describe the model, not the
  // port it happens to be on — but it must still start from a live endpoint.
  const runtimeCaps = await ctx.capabilities(model, await resolveBaseUrl());
  const thinkingKwargs = canUseThinkingKwargs(model, runtimeCaps);
  const stripThinkingChannels = shouldStripThinking(model, config);
  if (stripChoice.warning) void vscode.window.showWarningMessage(stripChoice.warning);
  warnAboutModel(ctx, model, config, runtimeCaps, thinkingKwargs);

  const maxRounds = resolveMaxToolRounds(model);
  const isVisionModel = deriveStaticCapabilities(model).includes('vision');
  // Single source of truth for the vision gate (B8): both halves derive from
  // the registry's `requiresVision` tools, so they cannot drift apart.
  // Keep vision tools advertised but refuse them at dispatch on text-only
  // models, so a call receives a clear capability explanation.
  const unattended = unattendedConversations.has(conv.id);
  const unattendedRefusals = withUnattendedRefusals(undefined, unattended);
  const unavailableTools = withUnattendedRefusals(
    isVisionModel ? undefined : buildVisionRefusals(ctx.toolRegistry, model.name),
    unattended,
  );
  // Config-derived, never per round: that would change the list mid-turn, cold prefill each time.
  const provider = model.provider ?? 'llama.cpp';
  const writeLimit = writeChunkLimit(model, config.llama_server, config.auto_compact, provider);
  const outputLimits = toolOutputLimits(model, config.llama_server, config.auto_compact, provider);
  // Rebuilt on every round, not snapshotted once: `load_tool_group` activates a lazy
  // group mid-turn and its schemas must reach the request that follows.
  const getToolDefinitions = () =>
    buildToolDefinitions(conv, model, ctx, allowed, unattendedRefusals, budget);
  const getTextCallDefinitions = () =>
    buildTextCallDefinitions(conv, model, ctx, allowed, unattendedRefusals, budget);
  assertTextCallsReadable(model);
  setSchemasInResult(conv.id, model.tool_groups?.schemas_in_result === true);
  setTextCallCatalog(conv.id, getTextCallDefinitions());
  const nativeTools = runtimeCaps?.likelySupportsTools !== false;
  if (getToolDefinitions().length > 0 && !nativeTools) {
    ctx.warnOnce(
      `${model.name}:tools`,
      `Forge: model "${model.name}" does not appear to have a tool-aware chat template. Forge will use its fallback tool format.`,
    );
  }

  announceMissingImages(conv, model, isVisionModel, { postC, warnOnce: ctx.warnOnce });

  // The prompt head, snapshotted once per turn: turnPromptSnapshot.ts.
  const { turnContext, instructions } = snapshotTurnPromptHead(ctx, conv, activeFile, unattended);
  const workspaceIsProjectRoot = ctx.forgeLoader?.root
    ? isProjectRoot(ctx.forgeLoader.root)
    : false;
  // Read once per turn, beside the other prompt-head snapshots. The service
  // freezes the catalog for the conversation, so a skill installed between this
  // turn's rounds cannot rewrite the system prompt and cost the rest of the turn
  // a cold re-prefill. `?.()` because a turn-context engine may be a bare render
  // stub in the prompt-shape tests; a missing catalog means no block.
  const skillsCatalog = ctx.templateEngine?.skillsCatalogFor?.(conv);
  const compactor = ctx.compactMidTurn;
  const outputBudget = createOutputBudgetTracker(conv, model, config.llama_server, provider);
  const result = await trackTurnCompletion(ctx.lifecycle, conv.id, () =>
    runToolCallingLoop({
      resolveBaseUrl,
      model,
      messages: conv.messages,
      getToolDefinitions,
      getTextCallDefinitions,
      onToolsOffered: (names, fingerprint) => ctx.onToolsOffered?.(conv.id, names, fingerprint),
      onTextToolCalls: (names, unlisted) => ctx.onTextToolCalls?.(conv.id, names, unlisted),
      onRequestStats: (capture) => ctx.onRequestStats?.(conv.id, capture),
      signal: ctrl.signal,
      maxRounds,
      writeChunkLimit: writeLimit,
      holdUntilTruncation: [{ tool: 'write_file', property: 'mode' }],
      nativeTools,
      stripAllTools: stripChoice.strip || model.strip_tools === true,
      includeUsage: true,
      canUseThinkingKwargs: thinkingKwargs,
      stripThinkingChannels,
      ...(apiKey ? { apiKey } : {}),
      ...(getApiKey ? { getApiKey } : {}),
      prepareMessages: (messages) => {
        const contextTrimState =
          conv.contextTrimState ?? (conv.contextTrimState = createContextTrimState());
        return prepareModelTurnMessages(messages, {
          compaction: conv.compaction,
          contextTrimState,
          isVisionModel,
          model,
          templateEngine: ctx.templateEngine,
          config,
          forgeLoader: ctx.forgeLoader,
          activeFile,
          forgeInstructions: instructions.system,
          workspaceIsProjectRoot,
          ...(skillsCatalog !== undefined ? { skillsCatalog } : {}),
          // Re-evaluated every round: compaction can move the window mid-turn (codingTipsPin.ts).
          codingTips: pinCodingTips(conv, ctx.forgeLoader?.root),
          turnContext,
          getToolDefinitions,
        });
      },
      dispatchToolCalls: async (toolCalls, messages) => {
        applyToolCalls(conv, toolCalls.length);
        for (const call of toolCalls) {
          // The activity row names the tool the call will reach, not the name the
          // model typed: a renderer keyed on toolName must not miss an alias.
          const shown = activityToolName(call.function.name, ctx.toolRegistry);
          ctx.emitAgentProgress({ conversationId: conv.id, kind: 'tool', toolName: shown });
          const detail = extractToolDetail(call.function.arguments);
          postC({
            type: 'toolActivity',
            toolName: shown,
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
          ctx.onTellArrived ? (callback) => ctx.onTellArrived!(conv.id, callback) : undefined,
          {
            modelName: model.name,
            isVisionModel,
            outputLimits,
            conversation: conv,
            ...(checkpoint ? { checkpoint } : {}),
            persistConversation: () => ctx.onTranscriptChanged?.(conv),
            ...(withQuestionWait ? { withQuestionWait } : {}),
            // Bound to this conversation here, so the tool never sees a
            // conversation id and cannot reach another chat's clock.
            ...(ctx.setCheckin
              ? {
                  setCheckin: (minutes: number, byThen: CheckinStage) =>
                    ctx.setCheckin!(conv.id, minutes, byThen),
                }
              : {}),
          },
        );
        mirrorLiveSessionAnswers(conv.id, toolCalls, messages, ctx.emitAgentProgress);
        // Token bar ticks in `onUsage`: a tool result moves no measured context.
      },
      isMutatingTool: (name) => isMutatingTool(ctx.toolRegistry.get(name)),
      onMessagesChanged: () => ctx.onTranscriptChanged?.(conv),
      ...(ctx.drainTells ? { drainTells: () => ctx.drainTells!(conv.id) } : {}),
      ...buildTurnStreamHandlers({ ctx, conv, model, postC, ctrl, outputBudget }),
      getOutputRoom: outputBudget.getOutputRoom,
      ...(compactor ? { compactMidTurn: (req) => compactor(conv, req) } : {}),
    }),
  );
  publishTurnOutcome({ ctx, conv, model, maxRounds, postC, result });
  return result;
}
