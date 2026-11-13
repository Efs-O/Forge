import type { ChatCompletionRequest } from '../llm/types';
import type { ModelConfig } from '../config/types';
import { nativeOnlyToolCalls } from './TextToolCallMode';

/**
 * Returns a copy of the request with tools removed.
 * Used as a fallback when a model fails tool calls repeatedly.
 */
export function stripTools(request: ChatCompletionRequest): ChatCompletionRequest {
  const stripped: ChatCompletionRequest & { tool_choice?: unknown } = { ...request };
  delete stripped.tools;
  delete stripped.tool_choice;
  return stripped;
}

/**
 * Tracks, per conversation, the ONE failure that says something about the
 * protocol rather than about one call: the server could not parse the native
 * tool call this model just made. After THRESHOLD of those in one chat, Forge
 * stops sending that model native tool definitions and sends the fenced text
 * format instead — the recovery `agent/ToolCallingLoop` already implements.
 *
 * What deliberately does NOT count, because each says something else (audit R1:
 * counting them let one bad afternoon in one chat look like a model that cannot
 * call tools at all, and the notice said "tools disabled" when text tool calls
 * were working the whole time):
 *   - a tool's own error — a missing file, a bad path: the call reached the
 *     tool, so the protocol worked;
 *   - arguments that failed the tool's schema: the server parsed the call;
 *   - a decline, a policy refusal, an approval timeout: a human said no;
 *   - a truncated call: out of output room is an environment limit, and
 *     `agent/ToolCallingLoop` keeps it out of this counter for the same reason.
 *
 * The key is the conversation id, and `reset` must follow every successful tool
 * call: without either, one chat's bad afternoon disabled tool calling in every
 * other tab and kept it disabled forever, because the count only ever went up.
 */
export class ToolFailureTracker {
  private readonly failures = new Map<string, number>();
  static readonly THRESHOLD = 10;

  /** Used when a caller has no conversation to attribute the failure to. */
  static readonly DEFAULT_KEY = '__default__';

  /** The server rejected this model's native tool-call JSON. */
  recordNativeParseFailure(conversationId = ToolFailureTracker.DEFAULT_KEY): void {
    this.failures.set(conversationId, (this.failures.get(conversationId) ?? 0) + 1);
  }

  /** How many parse failures this chat has — the notice the user sees quotes it. */
  streak(conversationId = ToolFailureTracker.DEFAULT_KEY): number {
    return this.failures.get(conversationId) ?? 0;
  }

  /**
   * Clears this conversation's streak. Call it after a tool call that ran,
   * after starting or clearing a chat, and when a conversation goes away — an
   * entry for a closed conversation is otherwise a count no one can clear.
   */
  reset(conversationId = ToolFailureTracker.DEFAULT_KEY): void {
    this.failures.delete(conversationId);
  }

  shouldStrip(conversationId = ToolFailureTracker.DEFAULT_KEY): boolean {
    return (this.failures.get(conversationId) ?? 0) >= ToolFailureTracker.THRESHOLD;
  }
}

/**
 * What the threshold means for one model, decided in one place.
 *
 * The recovery is "send this model tools as text". A model set to
 * `text_tool_calls: native` has no text channel — stripping would hand it a
 * format it refuses to read, and the next turn would offer it tools that run
 * nowhere. So for that model the native schemas stay, each broken call is
 * refused where it happens, and the user hears why nothing changed.
 */
export function stripDecision(
  tracker: ToolFailureTracker,
  conversationId: string,
  model: Pick<ModelConfig, 'text_tool_calls'>,
): { strip: boolean; warning: string | undefined } {
  if (!tracker.shouldStrip(conversationId)) return { strip: false, warning: undefined };
  const streak = tracker.streak(conversationId);
  if (nativeOnlyToolCalls(model)) {
    return {
      strip: false,
      warning:
        `Forge: ${streak} native tool calls from this model failed to parse in this chat. ` +
        'Its tools stay native: text_tool_calls is set to native, so this model has no text ' +
        'channel to fall back to.',
    };
  }
  return {
    strip: true,
    warning:
      `Forge: ${streak} native tool calls from this model failed to parse in this chat, so tools ` +
      'are now sent to it as text — which still works. A tool call that runs clears this.',
  };
}
