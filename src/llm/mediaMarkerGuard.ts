import type { ChatMessage, ContentPart } from './types';

/**
 * llama-server with an mmproj splits the prompt on its media marker and
 * expects one image per occurrence. The marker is `<__media__>` on older
 * builds and a per-process random `<__media_XXXX__>` on newer ones, published
 * in `GET /props` as `media_marker`. Once that string is in the conversation as
 * plain text — an agent that curls `/props`, reads a log, or quotes one — every
 * later request fails with HTTP 400 "Failed to tokenize prompt", and the chat
 * cannot recover because the text stays in its history.
 *
 * Breaking the marker with a zero-width space keeps the text readable and makes
 * it inert. The rewrite is deterministic, so the prompt stays byte-identical
 * round to round and the slot cache is unaffected.
 */
const MEDIA_MARKER = /<__media_(\w*_>)/g;
const INERT = '<__media​_$1';

function scrub(text: string): string {
  return text.includes('<__media_') ? text.replace(MEDIA_MARKER, INERT) : text;
}

function scrubContent(content: ChatMessage['content']): ChatMessage['content'] {
  if (typeof content === 'string') return scrub(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const parts = content.map((part): ContentPart => {
    if (part.type !== 'text') return part;
    const text = scrub(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? parts : content;
}

function scrubMessage(message: ChatMessage): ChatMessage {
  const content = scrubContent(message.content);
  const reasoning =
    message.reasoning_content === undefined ? undefined : scrub(message.reasoning_content);
  let toolCalls = message.tool_calls;
  if (toolCalls?.some((call) => call.function.arguments.includes('<__media_'))) {
    toolCalls = toolCalls.map((call) => ({
      ...call,
      function: { ...call.function, arguments: scrub(call.function.arguments) },
    }));
  }
  if (
    content === message.content &&
    reasoning === message.reasoning_content &&
    toolCalls === message.tool_calls
  ) {
    return message;
  }
  return {
    ...message,
    content,
    ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
  };
}

/** Returns `messages` itself when nothing carries a marker. */
export function neutralizeMediaMarkers(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const out = messages.map((message) => {
    const next = scrubMessage(message);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? out : messages;
}
