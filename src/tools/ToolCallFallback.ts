import type { ToolCall } from '../llm/types';
import { parseStructuredOutput } from './StructuredOutputParser';

/**
 * Converts JSON-fenced fallback tool blocks into synthetic OpenAI-style tool calls.
 * This allows models without native function-calling support to request tools.
 */
export function extractFallbackToolCalls(text: string): ToolCall[] | null {
  const parsed = parseStructuredOutput(text);
  if (!parsed.length) return null;

  return parsed.map((call, index) => ({
    id: `fallback-tool-${Date.now()}-${index}`,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  }));
}
