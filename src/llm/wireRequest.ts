import type { ChatCompletionRequest, ChatMessage } from './types';

const MID_TURN_WIRE_LABEL =
  '[Sent by the user while you were working. If it changes the task, adjust; otherwise acknowledge it in one line and continue.]';

export function wireMessageContent(
  message: Pick<ChatMessage, 'content' | 'midTurn'>,
): ChatMessage['content'] {
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
