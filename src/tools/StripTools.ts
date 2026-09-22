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
 * Tracks consecutive tool-call failures per session.
 * After THRESHOLD failures, recommends strip mode.
 */
export class ToolFailureTracker {
  private readonly failures = new Map<string, number>();
  static readonly THRESHOLD = 3;

  record(conversationId = '__default__'): void {
    this.failures.set(conversationId, (this.failures.get(conversationId) ?? 0) + 1);
  }

  reset(conversationId = '__default__'): void {
    this.failures.delete(conversationId);
  }

  shouldStrip(conversationId = '__default__'): boolean {
    return (this.failures.get(conversationId) ?? 0) >= ToolFailureTracker.THRESHOLD;
  }
}
