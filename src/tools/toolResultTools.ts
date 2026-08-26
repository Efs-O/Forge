import type { ChatMessage } from '../llm/types';
import type { RegisteredTool, ToolHandlerContext } from './ToolRegistry';

/** A bounded range keeps recovery from recreating the original context spike. */
export const MAX_TOOL_RESULT_READ_CHARS = 6_000;

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

function readRange(args: Record<string, unknown>, context?: ToolHandlerContext): string {
  const toolCallId = args['tool_call_id'] as string;
  const offset = (args['offset'] as number | undefined) ?? 0;
  const maxChars = Math.min(
    (args['max_chars'] as number | undefined) ?? MAX_TOOL_RESULT_READ_CHARS,
    MAX_TOOL_RESULT_READ_CHARS,
  );
  const text = rawResult(context?.conversationMessages, toolCallId);
  if (text === undefined) {
    return `Error: no text tool result with call ID "${toolCallId}" exists in this conversation.`;
  }
  if (offset >= text.length) {
    return `Tool result ${toolCallId}: requested offset ${offset} is beyond its ${text.length} characters.`;
  }
  const end = Math.min(text.length, offset + maxChars);
  return `Tool result ${toolCallId}, chars ${offset}-${end} of ${text.length}:\n${text.slice(offset, end)}`;
}

/** Read an exact bounded range from a raw earlier tool result in this chat. */
export function makeReadToolResultTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'read_tool_result',
        description:
          'Read an exact bounded character range from a previous tool result in this conversation. ' +
          'Use the tool_call_id and range shown in a Forge tool-result excerpt.',
        parameters: {
          type: 'object',
          properties: {
            tool_call_id: { type: 'string', minLength: 1, description: 'Previous tool call ID.' },
            offset: { type: 'integer', minimum: 0, description: 'Zero-based character offset.' },
            max_chars: {
              type: 'integer',
              minimum: 1,
              maximum: MAX_TOOL_RESULT_READ_CHARS,
              description: 'Characters to return, capped at 6000.',
            },
          },
          required: ['tool_call_id'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    autoApprove: true,
    handler: async (args, context) => readRange(args, context),
  };
}
