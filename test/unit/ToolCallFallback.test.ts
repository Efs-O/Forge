import { describe, expect, it } from 'vitest';
import { extractFallbackToolCalls } from '../../src/tools/ToolCallFallback';

const TOOL_CALLS_BEGIN = '<｜tool▁calls▁begin｜>';
const TOOL_CALL_BEGIN = '<｜tool▁call▁begin｜>';
const TOOL_SEP = '<｜tool▁sep｜>';
const TOOL_CALL_END = '<｜tool▁call▁end｜>';
const TOOL_CALLS_END = '<｜tool▁calls▁end｜>';

describe('extractFallbackToolCalls', () => {
  it('parses a fenced JSON tool block into a synthetic tool call', () => {
    const calls = extractFallbackToolCalls(
      [
        '```json',
        '{',
        '  "tool": "write_file",',
        '  "arguments": {',
        '    "path": "src/example.ts",',
        '    "content": "export const ok = true;\\n"',
        '  }',
        '}',
        '```',
      ].join('\n'),
    );

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
    const calls = extractFallbackToolCalls(
      [
        'The user is asking me to audit their codebase.',
        TOOL_CALLS_BEGIN,
        `${TOOL_CALL_BEGIN}ask_user${TOOL_SEP}{"prompt":"What type of audit do you want?"}${TOOL_CALL_END}`,
        TOOL_CALLS_END,
      ].join('\n'),
    );

    expect(calls).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls?.[0]?.function.name).toBe('ask_user');
    expect(JSON.parse(calls?.[0]?.function.arguments ?? '{}')).toEqual({
      prompt: 'What type of audit do you want?',
    });
  });

  it('parses multiple Ollama marker tool calls from one response', () => {
    const calls = extractFallbackToolCalls(
      [
        TOOL_CALLS_BEGIN,
        `${TOOL_CALL_BEGIN}read_file${TOOL_SEP}{"path":"src/index.ts"}${TOOL_CALL_END}`,
        `${TOOL_CALL_BEGIN}ask_user${TOOL_SEP}{"prompt":"Proceed?"}${TOOL_CALL_END}`,
        TOOL_CALLS_END,
      ].join(''),
    );

    expect(calls).not.toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls?.map((call) => call.function.name)).toEqual(['read_file', 'ask_user']);
  });

  it('turns malformed Ollama marker arguments into a model-facing tool error', () => {
    const calls = extractFallbackToolCalls(
      `${TOOL_CALL_BEGIN}read_file${TOOL_SEP}{"path":"bad\\q"}${TOOL_CALL_END}`,
    );
    expect(calls).toHaveLength(1);
    expect(calls?.[0]?.function.name).toBe('__tool_call_error__');
    expect(JSON.parse(calls?.[0]?.function.arguments ?? '{}')).toMatchObject({
      __error: expect.stringMatching(/^malformed tool call: its arguments are not valid JSON/u),
    });
  });

  it('turns a non-canonical fenced envelope into a model-facing refusal', () => {
    const definitions = [
      {
        type: 'function' as const,
        function: { name: 'read_file', description: '', parameters: { type: 'object' } },
      },
    ];
    const calls = extractFallbackToolCalls(
      '```json\n{"name":"read_file","arguments":{"path":"a"}}\n```',
      definitions,
    );
    expect(calls?.[0]?.function.name).toBe('__tool_call_error__');
    expect(JSON.parse(calls?.[0]?.function.arguments ?? '{}')).toEqual({
      __error: 'tool call: use {"tool": "<name>", "arguments": {...}}; the "name" form is not accepted.',
    });
  });

  it('types XML parameter strings from the tool schema', () => {
    const definitions = [
      {
        type: 'function' as const,
        function: {
          name: 'grep_search',
          description: '',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' }, max_results: { type: 'integer' } },
          },
        },
      },
    ];
    const calls = extractFallbackToolCalls(
      '<tool_call>\n<function=grep_search>\n<parameter=query>\n20\n</parameter>\n<parameter=max_results>\n20\n</parameter>\n</function>\n</tool_call>',
      definitions,
    );
    expect(JSON.parse(calls?.[0]?.function.arguments ?? '{}')).toEqual({
      query: '20',
      max_results: 20,
    });
  });

  it('ignores a JSON example that names no defined tool', () => {
    const definitions = [
      {
        type: 'function' as const,
        function: { name: 'read_file', description: '', parameters: { type: 'object' } },
      },
    ];
    const text = '```json\n{"compilerOptions": {"strict": true}}\n```';
    expect(extractFallbackToolCalls(text, definitions)).toBeNull();
  });
});
