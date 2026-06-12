import type { ToolDefinition } from '../llm/types';

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
