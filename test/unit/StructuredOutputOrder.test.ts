import { describe, expect, it } from 'vitest';
import { extractFallbackToolCalls } from '../../src/tools/ToolCallFallback';
import { parseStructuredOutput } from '../../src/tools/StructuredOutputParser';
import type { ToolDefinition } from '../../src/llm/types';

const NAMES = new Set(['read_file', 'write_file']);
const DEFINITIONS = [
  {
    type: 'function',
    function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: { name: 'write_file', parameters: { type: 'object', properties: {} } },
  },
] as unknown as ToolDefinition[];

const FENCE = (path: string): string =>
  '```json\n' + `{"tool": "write_file", "arguments": {"path": "${path}"}}\n` + '```';
const HERMES = (path: string): string =>
  `<tool_call>{"name": "read_file", "arguments": {"path": "${path}"}}</tool_call>`;

describe('calls run in the order the model wrote them', () => {
  it('a Hermes call before a fenced one is dispatched first', () => {
    const text = `First.\n${HERMES('one')}\nThen.\n${FENCE('two')}`;
    expect(parseStructuredOutput(text, NAMES).map((call) => call.name)).toEqual([
      'read_file',
      'write_file',
    ]);
  });

  it('a fenced call before a Hermes one keeps its place', () => {
    const text = `${FENCE('two')}\nthen\n${HERMES('one')}`;
    expect(parseStructuredOutput(text, NAMES).map((call) => call.name)).toEqual([
      'write_file',
      'read_file',
    ]);
  });

  it('the dispatch path gets the same order', () => {
    const text = `${HERMES('a')}\nand\n${HERMES('b')}`;
    const calls = extractFallbackToolCalls(text, DEFINITIONS);
    expect(calls?.map((call) => call.function.arguments)).toEqual(['{"path":"a"}', '{"path":"b"}']);
  });

  it('homogeneous formats still behave as they always did', () => {
    const text = `${FENCE('one')}\n${FENCE('two')}`;
    expect(parseStructuredOutput(text, NAMES)).toEqual([
      { name: 'write_file', arguments: { path: 'one' } },
      { name: 'write_file', arguments: { path: 'two' } },
    ]);
  });

  it('a fenced block inside a marker body is one call, not two', () => {
    const text = `<tool_call>\n${FENCE('a')}\n</tool_call>`;
    const found = parseStructuredOutput(text, NAMES);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('write_file');
  });
});
