import type { ChatMessage, ToolCall } from '../llm/types';

/**
 * The one assistant turn assembled while a model streams reasoning, then either
 * a tool call or its final answer. Keeping this state outside the loop keeps
 * the persisted transcript and the live Thinking row in lockstep.
 */
export class StreamedAssistantTurn {
  private current?: ChatMessage;

  constructor(private readonly messages: ChatMessage[]) {}

  appendReasoning(token: string): void {
    if (!this.current) {
      this.current = { role: 'assistant', content: '', reasoning: '' };
      this.messages.push(this.current);
    }
    this.current.reasoning = (this.current.reasoning ?? '') + token;
  }

  completeToolCall(calls: ToolCall[], content: string, reasoning: string): void {
    if (this.current) {
      this.current.content = content || null;
      this.current.tool_calls = calls;
      if (reasoning) this.current.reasoning = reasoning;
      return;
    }
    this.messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: calls,
      ...(reasoning ? { reasoning } : {}),
    });
  }

  completeAnswer(content: string, reasoning: string): void {
    if (this.current) {
      this.current.content = content;
      if (reasoning) this.current.reasoning = reasoning;
      return;
    }
    this.messages.push({
      role: 'assistant',
      content,
      ...(reasoning ? { reasoning } : {}),
    });
  }
}
