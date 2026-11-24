/**
 * How a turn's live output reaches the owner. Split out of `ModelTurn.ts`:
 * each handler below posts a webview message and/or ticks a meter, and none of
 * them influences what the next round sends. The control half of the loop's
 * callbacks (`prepareMessages`, `dispatchToolCalls`, `isMutatingTool`,
 * `getOutputRoom`, `drainTells`) stays with the request it shapes.
 */
import type { ModelConfig } from '../config/types';
import type { ConversationRuntime } from './sessionTypes';
import type { HostToWebview } from './messageBridge';
import type { ModelTurnContext } from './ModelTurn';
import type { ToolCallingLoopOptions } from '../agent/ToolCallingLoop';
import { toolCallProgressMsg } from './toolCallProgress';
import { reportRequestUsage } from './requestUsageReporting';

/** The observation half of `ToolCallingLoopOptions`, as one returnable object. */
export type TurnStreamHandlers = Pick<
  ToolCallingLoopOptions,
  | 'onToken'
  | 'onReasoning'
  | 'onToolCallProgress'
  | 'onRoundNarration'
  | 'onDone'
  | 'onRepeatedCall'
  | 'onNativeFallback'
  | 'onUsage'
  | 'onTruncatedToolCall'
>;

/**
 * The handlers for one turn's stream, bound to its conversation, model and
 * output budget. Spread into the `runToolCallingLoop` options.
 */
export function buildTurnStreamHandlers(input: {
  ctx: Pick<
    ModelTurnContext,
    | 'streamMeter'
    | 'emitAgentProgress'
    | 'failureTracker'
    | 'warnOnce'
    | 'onUsage'
    | 'onContextChanged'
  >;
  conv: ConversationRuntime;
  model: ModelConfig;
  postC: (msg: HostToWebview) => void;
  ctrl: AbortController;
  outputBudget: Parameters<typeof reportRequestUsage>[0]['outputBudget'];
}): TurnStreamHandlers {
  const { ctx, conv, model, postC, ctrl, outputBudget } = input;
  return {
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
    onNativeFallback: () => {
      ctx.failureTracker.recordNativeParseFailure(conv.id);
      ctx.warnOnce(
        `${model.name}:native-tool-json`,
        `Forge: llama-server rejected this model's native tool-call JSON. Retrying with Forge's JSON fallback tool format.`,
      );
    },
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
  };
}
