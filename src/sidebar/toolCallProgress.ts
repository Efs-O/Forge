import type { ToolCallProgress } from '../llm/OpenAIClient';
import type { ToolCallProgressMsg } from './messageBridge';
import { parseJsonWithInvalidEscapeRepair } from '../tools/argCoercion';

/** Read a path only after its JSON string closes in streamed arguments. */
export function partialToolPath(args: string): string | undefined {
  const match = /(?:^|[{,])\s*"path"\s*:\s*("(?:\\.|[^"\\])*")/.exec(args);
  if (!match) return undefined;
  const parsed = parseJsonWithInvalidEscapeRepair(match[1]!);
  return parsed.ok && typeof parsed.value === 'string' ? parsed.value : undefined;
}

/**
 * The webview's "still writing" row for a streamed tool call. `tokens` is the
 * argument delta count: llama-server streams one token per delta. Undefined
 * until the call's name has arrived, since a nameless row says nothing.
 */
export function toolCallProgressMsg(
  { index, id, name, arguments: args, argDeltas }: ToolCallProgress,
  conversationId?: string,
): ToolCallProgressMsg | undefined {
  if (!name) return undefined;
  const target = partialToolPath(args);
  return {
    type: 'toolCallProgress',
    ...(conversationId ? { conversationId } : {}),
    index,
    toolName: name,
    ...(id ? { toolCallId: id } : {}),
    ...(target ? { target } : {}),
    tokens: argDeltas,
  };
}
