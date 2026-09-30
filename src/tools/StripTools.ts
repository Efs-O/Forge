import type { ChatCompletionRequest } from '../llm/types';

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
 * Tracks consecutive tool-call failures per conversation.
 * After THRESHOLD failures, recommends strip mode.
 *
 * The key is the conversation id, and `reset` must follow every successful tool
 * call: without either, one chat's bad afternoon disabled tool calling in every
 * other tab and kept it disabled forever, because the count only ever went up.
 * A truncated tool call must NOT be recorded here — running out of output room
 * is an environment limit, not the model failing at tool calls (see
 * `agent/ToolCallingLoop`, which deliberately keeps truncation out of this
 * counter).
 */
export class ToolFailureTracker {
  private readonly failures = new Map<string, number>();
  static readonly THRESHOLD = 10;

  /** Used when a caller has no conversation to attribute the failure to. */
  static readonly DEFAULT_KEY = '__default__';

  record(conversationId = ToolFailureTracker.DEFAULT_KEY): void {
    this.failures.set(conversationId, (this.failures.get(conversationId) ?? 0) + 1);
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
