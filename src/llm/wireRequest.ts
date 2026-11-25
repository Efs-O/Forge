import type { ChatCompletionRequest, ChatMessage } from './types';

/** What the wire says in front of a real mid-turn user tell. Exported so the
 * tests pin the label the model reads, rather than retyping it. */
export const MID_TURN_WIRE_LABEL =
  '[Sent by the user while you were working. If it changes the task, adjust; otherwise acknowledge it in one line and continue.]';

export function wireMessageContent(
  message: Pick<ChatMessage, 'content' | 'midTurn' | 'internal'>,
): ChatMessage['content'] {
  // The label is a sentence about the user. Forge's own internal notes (the
  // elapsed-time note, the file-change reminder, the broken-markup nudge) are
  // mid-turn, but no user sent them: labelled, the model is told to "adjust" to
  // a message it cannot answer, and a rewrite here would change the wire bytes
  // of messages already in the cached prefix.
  if (message.internal === true) return message.content;
  if (!message.midTurn || typeof message.content !== 'string') return message.content;
  return `${MID_TURN_WIRE_LABEL}\n\n${message.content}`;
}

/** Keep sidebar-only bookkeeping out of provider requests and fingerprints. */
function toWireMessage(message: ChatMessage): ChatMessage {
  const wire: ChatMessage = { role: message.role, content: wireMessageContent(message) };
  if (message.tool_call_id !== undefined) wire.tool_call_id = message.tool_call_id;
  if (message.name !== undefined) wire.name = message.name;
  if (message.tool_calls !== undefined) wire.tool_calls = message.tool_calls;
  if (message.reasoning_content !== undefined) wire.reasoning_content = message.reasoning_content;
  return wire;
}

/** The message fields recognized by the OpenAI chat-completions wire format. */
export function toWireRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  return { ...request, messages: request.messages.map(toWireMessage) };
}
