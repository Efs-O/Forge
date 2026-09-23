import type { ToolCall, ToolDefinition } from '../llm/types';
import { parseStructuredOutput } from './StructuredOutputParser';

/**
 * Converts JSON-fenced fallback tool blocks into synthetic OpenAI-style tool calls.
 * This allows models without native function-calling support to request tools.
 * XML `<parameter>` values arrive as strings; `definitions` types them the way
 * llama-server's own parser would (a string-typed parameter stays a string).
 */
export function extractFallbackToolCalls(
  text: string,
  definitions: readonly ToolDefinition[] = [],
): ToolCall[] | null {
  const parsed = parseStructuredOutput(text);
  if (!parsed.length) return null;

  return parsed.map((call, index) => ({
    id: `fallback-tool-${Date.now()}-${index}`,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(typeArguments(call.name, call.arguments, definitions)),
    },
  }));
}

function typeArguments(
  name: string,
  args: Record<string, unknown>,
  definitions: readonly ToolDefinition[],
): Record<string, unknown> {
  const properties = definitions.find((d) => d.function.name === name)?.function.parameters
    .properties as Record<string, { type?: unknown }> | undefined;
  if (!properties) return args;
  const typed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key]?.type;
    typed[key] =
      typeof value === 'string' && type !== undefined && type !== 'string'
        ? parseOrKeep(value)
        : value;
  }
  return typed;
}

/** A non-string parameter as JSON; unparseable text is left for the tool's validator to name. */
function parseOrKeep(value: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch {
    return value;
  }
}
