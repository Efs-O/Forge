import type { ChatMessage, ToolDefinition } from '../llm/types';

export function buildFallbackToolInstructions(tools: ToolDefinition[]): string {
  const catalog = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));

  return [
    'Native tool calling is unavailable for this request.',
    'To call a tool, output exactly one fenced JSON block and no prose:',
    '```json',
    '{ "tool": "tool_name", "arguments": { "arg": "value" } }',
    '```',
    'Available tools:',
    JSON.stringify(catalog),
  ].join('\n');
}

/**
 * Adds the fallback catalog to the leading system message, or prepends one.
 * Never appends a trailing system message: Qwen's chat template raises "System
 * message must be at the beginning" on any system message after index 0, and
 * once ToolFailureTracker put a chat in strip mode every later turn in it
 * failed with HTTP 500.
 */
export function withFallbackToolInstructions(
  messages: ChatMessage[],
  tools: ToolDefinition[],
): ChatMessage[] {
  const instructions = buildFallbackToolInstructions(tools);
  const head = messages[0];
  if (head?.role === 'system' && typeof head.content === 'string') {
    return [{ ...head, content: `${head.content}\n\n${instructions}` }, ...messages.slice(1)];
  }
  if (head?.role === 'system' && Array.isArray(head.content)) {
    return [
      { ...head, content: [...head.content, { type: 'text', text: instructions }] },
      ...messages.slice(1),
    ];
  }
  return [{ role: 'system', content: instructions }, ...messages];
}
