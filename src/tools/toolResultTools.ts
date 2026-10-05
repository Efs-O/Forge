import type { ChatMessage, ContentPart } from '../llm/types';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';

/** A bounded range keeps recovery from recreating the original context spike. */
export const MAX_TOOL_RESULT_READ_CHARS = 6_000;

const MODE_GUIDANCE =
  'Use exactly one mode: tool_call_id for an exact tool result, query to search, or message_index for an exact user/assistant message.';

function rawResult(
  messages: readonly ChatMessage[] | undefined,
  toolCallId: string,
): string | undefined {
  return messages?.find(
    (message) =>
      message.role === 'tool' &&
      message.tool_call_id === toolCallId &&
      typeof message.content === 'string',
  )?.content as string | undefined;
}

function modeError(detail: string): string {
  return `Error: ${detail} ${MODE_GUIDANCE}`;
}

function hasMode(args: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function textContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is ContentPart & { type: 'text' } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function rangeOptions(
  args: Record<string, unknown>,
): { offset: number; maxChars: number; clamped: boolean } | string {
  const offset = args['offset'] ?? 0;
  const maxChars = args['max_chars'] ?? MAX_TOOL_RESULT_READ_CHARS;
  if (!Number.isInteger(offset) || (offset as number) < 0) {
    return modeError('The offset must be a non-negative integer.');
  }
  if (!Number.isInteger(maxChars) || (maxChars as number) < 1) {
    return modeError(
      `max_chars must be a positive integer, capped at ${MAX_TOOL_RESULT_READ_CHARS}.`,
    );
  }
  return {
    offset: offset as number,
    maxChars: Math.min(maxChars as number, MAX_TOOL_RESULT_READ_CHARS),
    clamped: (maxChars as number) > MAX_TOOL_RESULT_READ_CHARS,
  };
}

function readRange(args: Record<string, unknown>, context?: ToolHandlerContext): string {
  const toolCallId = args['tool_call_id'];
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    return modeError('tool_call_id must be a non-empty string.');
  }
  const range = rangeOptions(args);
  if (typeof range === 'string') return range;
  const text = rawResult(context?.conversationMessages, toolCallId);
  if (text === undefined) {
    return `Error: no text tool result with call ID "${toolCallId}" exists in this conversation.`;
  }
  const clampNote = range.clamped
    ? `max_chars clamped to ${String(MAX_TOOL_RESULT_READ_CHARS)}; use offset to page further.\n`
    : '';
  if (range.offset >= text.length) {
    return `${clampNote}Tool result ${toolCallId}: requested offset ${range.offset} is beyond its ${text.length} characters.`;
  }
  const end = Math.min(text.length, range.offset + range.maxChars);
  return `${clampNote}Tool result ${toolCallId}, chars ${range.offset}-${end} of ${text.length}:\n${text.slice(range.offset, end)}`;
}

function readMessage(args: Record<string, unknown>, messages: readonly ChatMessage[]): string {
  const index = args['message_index'];
  if (!Number.isInteger(index) || (index as number) < 0) {
    return modeError('message_index must be a non-negative integer.');
  }
  const messageIndex = index as number;
  const message = messages[messageIndex];
  if (!message) return modeError(`message_index ${messageIndex} is outside this conversation.`);
  if (message.role === 'tool') {
    return modeError(
      `message_index ${messageIndex} is a tool result; use its tool_call_id "${message.tool_call_id ?? ''}" instead.`,
    );
  }
  if (message.role !== 'user' && message.role !== 'assistant') {
    return modeError(`message_index ${messageIndex} is not a user or assistant message.`);
  }
  const range = rangeOptions(args);
  if (typeof range === 'string') return range;
  const text = textContent(message.content);
  if (range.offset >= text.length) {
    return `Message ${messageIndex}: requested offset ${range.offset} is beyond its ${text.length} characters.`;
  }
  const end = Math.min(text.length, range.offset + range.maxChars);
  return `Message ${messageIndex} (${message.role}), chars ${range.offset}-${end} of ${text.length}:\n${text.slice(range.offset, end)}`;
}

interface SearchHit {
  role: ChatMessage['role'];
  messageIndex: number;
  toolCallId?: string;
  offset: number;
  excerpt: string;
}

const SEARCH_EXCERPT_CHARS = 300;

function caseInsensitiveOffset(text: string, query: string): number {
  const folded = text.toLowerCase();
  const foldedOffset = folded.indexOf(query.toLowerCase());
  if (foldedOffset < 0 || folded.length === text.length) return foldedOffset;

  const originalOffsets: number[] = [];
  for (let originalOffset = 0; originalOffset < text.length; ) {
    const codePoint = text.codePointAt(originalOffset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    for (let index = 0; index < character.toLowerCase().length; index += 1) {
      originalOffsets.push(originalOffset);
    }
    originalOffset += character.length;
  }
  return originalOffsets[foldedOffset] ?? -1;
}

function searchHits(messages: readonly ChatMessage[], query: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (
      !message ||
      message.internal === true ||
      (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool')
    ) {
      continue;
    }
    const text = textContent(message.content);
    const offset = caseInsensitiveOffset(text, query);
    if (offset < 0) continue;
    const start = Math.max(0, offset - Math.floor((SEARCH_EXCERPT_CHARS - query.length) / 2));
    const end = Math.min(text.length, start + SEARCH_EXCERPT_CHARS);
    const adjustedStart = Math.max(0, end - SEARCH_EXCERPT_CHARS);
    hits.push({
      role: message.role,
      messageIndex,
      ...(message.role === 'tool' && typeof message.tool_call_id === 'string'
        ? { toolCallId: message.tool_call_id }
        : {}),
      offset,
      excerpt: text.slice(adjustedStart, end),
    });
  }
  return hits;
}

function renderHit(hit: SearchHit): string {
  const toolId =
    hit.toolCallId === undefined ? '' : `, tool_call_id ${JSON.stringify(hit.toolCallId)}`;
  return `[${hit.role} message_index ${hit.messageIndex}${toolId}, character offset ${hit.offset}]\n${hit.excerpt}`;
}

function readSearch(args: Record<string, unknown>, messages: readonly ChatMessage[]): string {
  const query = args['query'];
  if (typeof query !== 'string' || query.length < 2 || query.length > 200) {
    return modeError('query must contain between 2 and 200 characters.');
  }
  const maxMatches = args['max_matches'] ?? 6;
  if (!Number.isInteger(maxMatches) || (maxMatches as number) < 1 || (maxMatches as number) > 10) {
    return modeError('max_matches must be an integer from 1 to 10.');
  }
  const hits = searchHits(messages, query);
  if (hits.length === 0) {
    return `No matches for ${JSON.stringify(query)}. Use tool_call_id to read an exact tool result or message_index to read an exact user/assistant message.`;
  }

  const base = `Search results for ${JSON.stringify(query)} (newest first):`;
  let selected = hits.slice(0, maxMatches as number);
  const render = (): string => {
    const omitted = hits.length - selected.length;
    const notice =
      omitted > 0
        ? `\n\n${omitted} of ${hits.length} matching messages not shown; use a narrower query to see more.`
        : '';
    return `${base}\n${selected.map(renderHit).join('\n\n')}${notice}`;
  };
  while (selected.length > 0 && render().length > MAX_TOOL_RESULT_READ_CHARS) {
    selected = selected.slice(0, -1);
  }
  if (selected.length === 0) {
    return `Search found ${hits.length} matching messages, but none fit within the output limit; ${hits.length} matches not shown. Use a narrower query.`;
  }
  return render();
}

function readToolResult(args: Record<string, unknown>, context?: ToolHandlerContext): string {
  const modes = ['tool_call_id', 'query', 'message_index'].filter((key) => hasMode(args, key));
  if (modes.length !== 1) {
    return modeError(`Received ${modes.length} modes;`);
  }
  const messages = context?.conversationMessages ?? [];
  switch (modes[0]) {
    case 'tool_call_id':
      return readRange(args, context);
    case 'query':
      return readSearch(args, messages);
    case 'message_index':
      return readMessage(args, messages);
    default:
      return modeError('No supported mode was selected.');
  }
}

/** Read or search earlier conversation content, including text before compaction. */
export function makeReadToolResultTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'read_tool_result',
        description:
          'Search and read earlier text in this conversation, including messages before a compaction. ' +
          'Use query for literal search, message_index for an exact user/assistant message, or tool_call_id for an exact tool result.',
        parameters: {
          type: 'object',
          properties: {
            tool_call_id: {
              type: 'string',
              minLength: 1,
              description: 'Exact tool-result mode: previous tool call ID.',
            },
            query: {
              type: 'string',
              minLength: 2,
              maxLength: 200,
              description: 'Search mode: literal case-insensitive text to find.',
            },
            message_index: {
              type: 'integer',
              minimum: 0,
              description: 'Exact-message mode: zero-based user or assistant message index.',
            },
            max_matches: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              description: 'Search result limit; defaults to 6.',
            },
            offset: {
              type: 'integer',
              minimum: 0,
              description: 'Exact-mode zero-based character offset.',
            },
            max_chars: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_TOOL_RESULT_READ_CHARS,
              description: 'Exact-mode characters to return, capped at 6000.',
            },
          },
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    autoApprove: true,
    handler: async (args, context) => readToolResult(args, context),
  };
}
