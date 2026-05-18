import { describe, expect, it } from 'vitest';
import { extractFallbackToolCalls } from '../../src/tools/ToolCallFallback';

const TOOL_CALLS_BEGIN = '<｜tool▁calls▁begin｜>';
const TOOL_CALL_BEGIN = '<｜tool▁call▁begin｜>';
const TOOL_SEP = '<｜tool▁sep｜>';
const TOOL_CALL_END = '<｜tool▁call▁end｜>';
const TOOL_CALLS_END = '<｜tool▁calls▁end｜>';

describe('extractFallbackToolCalls', () => {
  it('parses a fenced JSON tool block into a synthetic tool call', () => {
    const calls = extractFallbackToolCalls([
      '```json',
      '{',
      '  "tool": "write_file",',
      '  "arguments": {',
      '    "path": "src/example.ts",',
      '    "content": "export const ok = true;\\n"',
      '  }',
      '}',
      '```',
    ].join('\n'));

    expect(calls).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls?.[0]?.function.name).toBe('write_file');
    expect(JSON.parse(calls?.[0]?.function.arguments ?? '{}')).toEqual({
      path: 'src/example.ts',
      content: 'export const ok = true;\n',
    });
  });

  it('returns null when no supported tool block is present', () => {
    expect(extractFallbackToolCalls('I cannot use tools.')).toBeNull();
  });

  it('parses Ollama marker tool calls into synthetic tool calls', () => {
    const calls = extractFallbackToolCalls([
      'The user is asking me to audit their codebase.',
      TOOL_CALLS_BEGIN,
      `${TOOL_CALL_BEGIN}ask_user${TOOL_SEP}{"prompt":"What type of audit do you want?"}${TOOL_CALL_END}`,
      TOOL_CALLS_END,
    ].join('\n'));

    expect(calls).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls?.[0]?.function.name).toBe('ask_user');
    expect(JSON.parse(calls?.[0]?.function.arguments ?? '{}')).toEqual({
      prompt: 'What type of audit do you want?',
    });
  });

  it('parses multiple Ollama marker tool calls from one response', () => {
    const calls = extractFallbackToolCalls([
      TOOL_CALLS_BEGIN,
      `${TOOL_CALL_BEGIN}read_file${TOOL_SEP}{"path":"src/index.ts"}${TOOL_CALL_END}`,
      `${TOOL_CALL_BEGIN}ask_user${TOOL_SEP}{"prompt":"Proceed?"}${TOOL_CALL_END}`,
      TOOL_CALLS_END,
    ].join(''));

    expect(calls).not.toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls?.map((call) => call.function.name)).toEqual(['read_file', 'ask_user']);
  });
});
