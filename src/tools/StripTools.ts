import type { ChatCompletionRequest } from '../llm/types';

/**
 * Returns a copy of the request with tools removed.
 * Used as a fallback when a model fails tool calls repeatedly.
 */
export function stripTools(request: ChatCompletionRequest): ChatCompletionRequest {
  const {
    tools: _tools,
    tool_choice: _tc,
    ...rest
  } = request as ChatCompletionRequest & { tools?: unknown; tool_choice?: unknown };
  return rest as ChatCompletionRequest;
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
