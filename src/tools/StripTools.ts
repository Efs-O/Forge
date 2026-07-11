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
  private failures = 0;
  static readonly THRESHOLD = 3;

  record(): void {
    this.failures++;
  }

  reset(): void {
    this.failures = 0;
  }

  shouldStrip(): boolean {
    return this.failures >= ToolFailureTracker.THRESHOLD;
  }
}
