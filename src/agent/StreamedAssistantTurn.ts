import type { ChatMessage, ToolCall } from '../llm/types';

/**
 * The one assistant turn assembled while a model streams reasoning, then either
 * a tool call or its final answer. Keeping this state outside the loop keeps
 * the persisted transcript and the live Thinking row in lockstep.
 */
export class StreamedAssistantTurn {
  private current?: ChatMessage;
  private reasoningStartedAt?: number;
  private reasoningEndedAt?: number;

  constructor(private readonly messages: ChatMessage[]) {}

  appendReasoning(token: string): void {
    if (!this.current) {
      this.current = { role: 'assistant', content: '', reasoning: '' };
      this.messages.push(this.current);
    }
    this.current.reasoning = (this.current.reasoning ?? '') + token;
    // First token to last token, not first token to turn end. The gap between
    // the last thought and the answer landing is transport, not thinking, and
    // folding it in would inflate every measurement by the model's time to
    // first content token.
    const now = Date.now();
    this.reasoningStartedAt ??= now;
    this.reasoningEndedAt = now;
  }

  /**
   * The measured span, or undefined when this turn never reasoned.
   *
   * A span of exactly zero is dropped rather than recorded: every token landed
   * inside the same millisecond, which means the stream arrived buffered, not
   * that the model thought instantaneously. Recording it would put a measured
   * `0` on the message and let a reader take it for a real reading.
   */
  private elapsedReasoningMs(): number | undefined {
    if (this.reasoningStartedAt === undefined || this.reasoningEndedAt === undefined) {
      return undefined;
    }
    const elapsed = this.reasoningEndedAt - this.reasoningStartedAt;
    return elapsed > 0 ? elapsed : undefined;
  }

  completeToolCall(calls: ToolCall[], content: string, reasoning: string): void {
    const elapsed = this.elapsedReasoningMs();
    if (this.current) {
      this.current.content = content || null;
      this.current.tool_calls = calls;
      if (reasoning) this.current.reasoning = reasoning;
      if (elapsed !== undefined) this.current.reasoningMs = elapsed;
      return;
    }
    this.messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: calls,
      ...(reasoning ? { reasoning } : {}),
      ...(elapsed !== undefined ? { reasoningMs: elapsed } : {}),
    });
  }

  completeAnswer(content: string, reasoning: string): void {
    const elapsed = this.elapsedReasoningMs();
    if (this.current) {
      this.current.content = content;
      if (reasoning) this.current.reasoning = reasoning;
      if (elapsed !== undefined) this.current.reasoningMs = elapsed;
      return;
    }
    this.messages.push({
      role: 'assistant',
      content,
      ...(reasoning ? { reasoning } : {}),
      ...(elapsed !== undefined ? { reasoningMs: elapsed } : {}),
    });
  }
}
