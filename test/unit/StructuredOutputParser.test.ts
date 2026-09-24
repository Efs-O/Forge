import { describe, expect, it } from 'vitest';
import {
  StructuredOutputStripper,
  parseStructuredOutput,
  stripStructuredOutputFromFullText,
} from '../../src/tools/StructuredOutputParser';

const TOOL_CALLS_BEGIN = '<｜tool▁calls▁begin｜>';
const TOOL_CALL_BEGIN = '<｜tool▁call▁begin｜>';
const TOOL_SEP = '<｜tool▁sep｜>';
const TOOL_CALL_END = '<｜tool▁call▁end｜>';
const TOOL_CALLS_END = '<｜tool▁calls▁end｜>';

describe('StructuredOutputStripper', () => {
  it('hides Ollama tool markers split across streamed chunks', () => {
    const stripper = new StructuredOutputStripper();
    const chunks = [
      `Before ${TOOL_CALLS_BEGIN}${TOOL_CALL_BEGIN}read_file`,
      `${TOOL_SEP}{"path":"src/index.ts"}${TOOL_CALL_END}${TOOL_CALLS_END}`,
      ' after',
    ];

    const visible = chunks.map((chunk) => stripper.push(chunk)).join('') + stripper.flush();
    expect(visible).toBe('Before  after');
  });

  it('removes fenced tool JSON from persisted assistant text', () => {
    const text = [
      'Plan:',
      '```json',
      '{',
      '  "tool": "read_file",',
      '  "arguments": { "path": "src/index.ts" }',
      '}',
      '```',
      'Done.',
    ].join('\n');

    expect(stripStructuredOutputFromFullText(text)).toBe('Plan:\n\nDone.');
  });
});

describe('Hermes <tool_call> JSON in content', () => {
  // Qwopus emitted exactly this as text after its first native call.
  const text = [
    'Reading it.',
    '<tool_call>',
    '{"name": "read_file", "arguments": {"path": "src/a.ts"}}',
    '</tool_call>',
  ].join('\n');

  it('parses it as a tool call', () => {
    expect(parseStructuredOutput(text)).toEqual([
      { name: 'read_file', arguments: { path: 'src/a.ts' } },
    ]);
  });

  it('strips it from persisted text', () => {
    expect(stripStructuredOutputFromFullText(text)).toBe('Reading it.\n');
  });

  it('leaves non-call bodies alone', () => {
    const prose = '<tool_call>\nnot a call\n</tool_call>';
    expect(parseStructuredOutput(prose)).toEqual([]);
    expect(stripStructuredOutputFromFullText(prose)).toBe(prose);
  });
});

describe('XML <function=...> tool calls in content', () => {
  // Qwen3.8 Q6 on 0.16.41 answered with exactly this as text; nothing ran.
  const call = (query: string) =>
    [
      '<tool_call>',
      '<function=search_code>',
      '<parameter=query>',
      query,
      '</parameter>',
      '<parameter=max_results>',
      '20',
      '</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');
  const text = `${call('(no profile)')}\n${call('no profile')}`;

  it('parses each block, values as raw strings', () => {
    expect(parseStructuredOutput(text)).toEqual([
      { name: 'search_code', arguments: { query: '(no profile)', max_results: '20' } },
      { name: 'search_code', arguments: { query: 'no profile', max_results: '20' } },
    ]);
  });

  it('keeps multi-line values intact', () => {
    const body = '<tool_call>\n<function=write_file>\n<parameter=content>\na\n\nb\n</parameter>\n</function>\n</tool_call>';
    expect(parseStructuredOutput(body)).toEqual([
      { name: 'write_file', arguments: { content: 'a\n\nb' } },
    ]);
  });

  it('strips them from persisted text', () => {
    expect(stripStructuredOutputFromFullText(`Searching.\n${text}`)).toBe('Searching.\n\n');
  });
});

describe('```json blocks limited to known tools', () => {
  const tools = new Set(['write_file']);
  const example = 'Use this tsconfig:\n```json\n{"compilerOptions": {"strict": true}}\n```\nDone.';

  it('does not read an ordinary JSON example as a call', () => {
    expect(parseStructuredOutput(example, tools)).toEqual([]);
    expect(stripStructuredOutputFromFullText(example, tools)).toBe(example);
  });

  it('still reads and strips a block that calls a known tool', () => {
    const call = 'Writing.\n```json\n{"tool": "write_file", "arguments": {"path": "a"}}\n```';
    expect(parseStructuredOutput(call, tools)).toEqual([
      { name: 'write_file', arguments: { path: 'a' } },
    ]);
    expect(stripStructuredOutputFromFullText(call, tools)).toBe('Writing.\n');
  });
});

describe('StructuredOutputStripper.flush', () => {
  it('returns a held tail that never became a marker', () => {
    const stripper = new StructuredOutputStripper();
    expect(stripper.push('use a <') + stripper.flush()).toBe('use a <');
  });
});
