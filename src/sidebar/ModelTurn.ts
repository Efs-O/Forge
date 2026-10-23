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
import type { ToolDefinition } from '../llm/types';
import type { MidTurnDrainResult } from '../agent/MidTurnInbox';
import type { CheckinStage } from '../agent/elapsedTimeNote';
import { createContextTrimState } from '../agent/toolResultContext';
import type { ToolDispatch } from './ToolDispatch';
import type { ToolFailureTracker } from '../tools/StripTools';
import type { TurnLifecycle } from './TurnLifecycle';
import { createOutputBudgetTracker, perSlotContext } from '../util/contextBudget';
import { announceMissingImages } from './imageNotices';
import { prepareModelTurnMessages } from './prepareModelTurnMessages';
import { resolveToolPermissions } from '../tools/PermissionResolver';
import { ToolBudget } from '../tools/ToolBudget';
import { hiddenLazyToolNames } from '../tools/lazyToolGroups';
import { deriveStaticCapabilities } from '../config/ConfigResolver';
import { applyToolCalls } from './transcriptMutations';
import { mirrorLiveSessionAnswers } from './liveSessionMirror';
import { extractToolDetail } from './toolSummary';
import { freezeTurnContextAndConsumeResumeNote, type TurnContextState } from './turnContext';
import { formatCompactionResumeNote } from './compactionTypes';
import { terminalCommandTracker } from '../tools/TerminalCommandTracker';
import { toolOutputLimits } from '../tools/toolOutputLimits';
import { localDate } from '../util/localClock';
import { buildVisionRefusals } from './visionGate';
import { unattendedConversations, withUnattendedRefusals } from './unattendedConversations';
import {
  isTurnCutOffError,
  ROUND_CAP_INCOMPLETE_PREFIX,
  runToolCallingLoop,
  type ToolCallingLoopResult,
} from '../agent/ToolCallingLoop';
import { canUseThinkingKwargs, isProjectRoot, shouldStripThinking } from './turnModelBehavior';
import { runningBackgroundExecutionsNotice } from './backgroundExitNotice';
import type { AgentProgressEvent } from './AgentProgress';
import type { LiveStreamMeter } from './LiveStreamMeter';
import { writeChunkLimit } from '../tools/writeChunking';
import { toolCallProgressMsg } from './toolCallProgress';
import type { RequestOfferedListener } from '../sessions/requestFingerprint';
import type { RequestCapture } from '../sessions/requestStats';
import { reportRequestUsage } from './requestUsageReporting';

function activeTerminalCwd(): string | undefined {
  const cwd = vscode.window.activeTerminal?.shellIntegration?.cwd;
  if (!cwd) return undefined;
  return cwd.scheme === 'file' ? cwd.fsPath : cwd.toString(true);
}

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
  onRequestStats?: (conversationId: string, capture: RequestCapture) => void;
  onTranscriptChanged?: (conv: ConversationRuntime) => void;
  emitAgentProgress: (event: AgentProgressEvent) => void;
  streamMeter?: LiveStreamMeter;
  /** Remote chats bound to a conversation. Absent when no transport is live. */
  remoteReach?: (conversationId: string) => number;
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
  const perSlot = perSlotContext(model, config.llama_server, model.provider ?? 'llama.cpp');
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
  { resolveBaseUrl, conv, model, activeFile, ctrl, postC, apiKey, checkpoint }: ModelTurnRequest,
): Promise<ToolCallingLoopResult> {
  const config = ctx.getConfig();
  // A cancelled request never reports usage; its leftover estimate must not
  // carry into this turn's first request.
  ctx.streamMeter?.reset(conv.id);
  const allowed = resolveToolPermissions(config);
  // One budget per turn — model is already resolveRequestModel()'d
  // (group tools/tool_call_limits merged) by the caller.
  const budget = new ToolBudget(model);
  const useStrip = ctx.failureTracker.shouldStrip(conv.id);
  // One probe per turn is right — capabilities describe the model, not the
  // port it happens to be on — but it must still start from a live endpoint.
  const runtimeCaps = await ctx.capabilities(model, await resolveBaseUrl());
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
  // Config-derived, never per round: a per-round value would change the tool
  // list mid-turn and cost a cold prefill each time.
  const provider = model.provider ?? 'llama.cpp';
  const writeLimit = writeChunkLimit(model, config.llama_server, config.auto_compact, provider);
  const outputLimits = toolOutputLimits(model, config.llama_server, config.auto_compact, provider);
  // Rebuilt on every round rather than snapshotted once per turn: a lazy tool
  // group activates mid-turn via `load_tool_group`, and its schemas have to
  // reach the request that immediately follows.
  const buildToolDefinitions = (): ToolDefinition[] => {
    const hiddenLazyTools = hiddenLazyToolNames(
      conv.id,
      new Set(model.tools ?? []),
      new Set(model.tool_groups?.eager ?? []),
    );
    const advertised = ctx.toolRegistry
      .definitions(allowed)
      .filter(
        ({ function: { name } }) => !hiddenLazyTools.has(name) && !unattendedRefusals?.has(name),
      );
    return budget.filterDefinitions(advertised);
  };
  const nativeTools = runtimeCaps?.likelySupportsTools !== false;
  if (buildToolDefinitions().length > 0 && !nativeTools) {
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
  // two consecutive 186-token prompt growths re-evaluated 15401 tokens (~20 s).
  // It need not be re-rendered: update_plan's result confirms the write, and the
  // new plan reaches the next USER turn, which extends the prefix anyway. `items`
  // is copied so a later in-place edit of conv.plan cannot reach this prompt.
  const remoteChats = ctx.remoteReach?.(conv.id) ?? 0;
  const userTerminalCommands = terminalCommandTracker.recentUserCommands();
  const terminalCwd = userTerminalCommands.length > 0 ? activeTerminalCwd() : undefined;
  const turnContext: TurnContextState = {
    activeFile,
    currentDate: localDate(),
    ...(userTerminalCommands.length > 0 ? { userTerminalCommands } : {}),
    ...(terminalCwd ? { activeTerminalCwd: terminalCwd } : {}),
    ...(conv.plan ? { plan: { items: [...conv.plan.items], updatedAt: conv.plan.updatedAt } } : {}),
    // Snapshotted with the rest of Layer C: a chat binding that changes
    // mid-turn must not rewrite the prompt near the head and cost this turn's
    // own tool rounds.
    ...(remoteChats > 0 ? { remoteChats } : {}),
    ...(unattended ? { unattended } : {}),
    compactionResume: formatCompactionResumeNote(conv.compaction?.resumeNote),
  };
  freezeTurnContextAndConsumeResumeNote(conv.messages, turnContext, conv.compaction);
  const workspaceIsProjectRoot = ctx.forgeLoader?.root
    ? isProjectRoot(ctx.forgeLoader.root)
    : false;
  const compactor = ctx.compactMidTurn;
  const outputBudget = createOutputBudgetTracker(conv, model, config.llama_server, provider);
  const result = await trackTurnCompletion(ctx.lifecycle, conv.id, () =>
    runToolCallingLoop({
      resolveBaseUrl,
      model,
      messages: conv.messages,
      getToolDefinitions: buildToolDefinitions,
      onToolsOffered: (names, fingerprint) => ctx.onToolsOffered?.(conv.id, names, fingerprint),
      onRequestStats: (capture) => ctx.onRequestStats?.(conv.id, capture),
      signal: ctrl.signal,
      maxRounds,
      writeChunkLimit: writeLimit,
      offerAfterTruncation: ['append_file'],
      nativeTools,
      stripAllTools: useStrip || model.strip_tools === true,
      includeUsage: true,
      canUseThinkingKwargs: thinkingKwargs,
      stripThinkingChannels,
      ...(apiKey ? { apiKey } : {}),
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
          workspaceIsProjectRoot,
          turnContext,
          getToolDefinitions: buildToolDefinitions,
        });
      },
      dispatchToolCalls: async (toolCalls, messages) => {
        applyToolCalls(conv, toolCalls.length);
        for (const call of toolCalls) {
          ctx.emitAgentProgress({
            conversationId: conv.id,
            kind: 'tool',
            toolName: call.function.name,
          });
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
          ctx.onTellArrived ? (callback) => ctx.onTellArrived!(conv.id, callback) : undefined,
          {
            modelName: model.name,
            isVisionModel,
            outputLimits,
            conversation: conv,
            ...(checkpoint ? { checkpoint } : {}),
            persistConversation: () => ctx.onTranscriptChanged?.(conv),
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
      onMessagesChanged: () => ctx.onTranscriptChanged?.(conv),
      ...(ctx.drainTells ? { drainTells: () => ctx.drainTells!(conv.id) } : {}),
      onToken: (text, createdAt) => {
        ctx.streamMeter?.add(conv.id, 'answer', text);
        postC({ type: 'token', text, ...(createdAt !== undefined ? { createdAt } : {}) });
        ctx.emitAgentProgress({ conversationId: conv.id, kind: 'commentary', text });
      },
      onReasoning: (text, createdAt) => {
        ctx.streamMeter?.add(conv.id, 'reasoning', text);
        postC({
          type: 'reasoningToken',
          text,
          ...(createdAt !== undefined ? { createdAt } : {}),
        });
        ctx.emitAgentProgress({ conversationId: conv.id, kind: 'reasoning' });
      },
      onToolCallProgress: (progress) => {
        const msg = toolCallProgressMsg(progress);
        if (msg) postC(msg);
      },
      // The round's own words, once it has finished saying them. Only remote
      // surfaces act on this: the sidebar already rendered every token of it.
      onRoundNarration: (text) =>
        ctx.emitAgentProgress({ conversationId: conv.id, kind: 'narration', text }),
      onDone: (finishReason) => {
        postC({ type: 'done', finishReason: ctrl.signal.aborted ? 'cancelled' : finishReason });
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
      onUsage: (usage, request) => {
        reportRequestUsage({
          conv,
          usage,
          request,
          outputBudget,
          onUsage: ctx.onUsage,
          streamMeter: ctx.streamMeter,
          onContextChanged: ctx.onContextChanged,
        });
      },
      // A status line, not an error: the turn continues and the model is being
      // asked for the same write in chunks.
      onTruncatedToolCall: ({ toolName, approxBytes }) => {
        const safeToolName = toolName ?? 'tool call';
        postC({
          type: 'toolActivity',
          toolName: safeToolName,
          detail: `output cut off after ${approxBytes} bytes — retrying in chunks`,
        });
        ctx.emitAgentProgress({
          conversationId: conv.id,
          kind: 'tool',
          toolName: safeToolName,
        });
      },
      getOutputRoom: outputBudget.getOutputRoom,
      ...(compactor ? { compactMidTurn: (req) => compactor(conv, req) } : {}),
    }),
  );
  // Final publish for the turn. The per-round ticks above are throttled, so
  // the last one may have been coalesced away.
  ctx.onContextChanged?.(conv.id);
  // Cut off by the output ceiling: the reply stopped mid-thought, so the work
  // is unfinished even though the loop returned normally.
  if (result.finishReason === 'length') {
    ctx.lifecycle.markIncomplete(conv.id, 'the reply was cut off by the output limit');
    // An empty cut-off reply needs an explicit cause and recovery path.
    if (!result.finalText) {
      postC({
        type: 'notice',
        message:
          'Forge: the model used its whole output budget on reasoning and was cut off ' +
          'before answering. The context is nearly full — run /compact, or lower ' +
          `\`--reasoning-budget\` for "${model.name}".`,
      });
    }
  }
  // The model ended its own generation mid-thought (see ToolCallingLoop). Not
  // the output limit, so /compact is not the remedy; a plain retry usually is.
  if (result.stoppedWhileReasoning) {
    ctx.lifecycle.markIncomplete(conv.id, 'the model stopped while still reasoning');
    postC({
      type: 'notice',
      // Warning, so a remote chat gets a push: the user must send "continue".
      severity: 'warning',
      message:
        'Forge: the model ended its reply mid-thought twice (the automatic retry with ' +
        'thinking off also produced nothing). Say "continue" to resume.',
    });
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
  const running = runningBackgroundExecutionsNotice(conv.id);
  if (running) postC({ type: 'notice', message: running });
  return result;
}
