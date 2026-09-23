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

  it('leaves the XML <function=...> form and non-call bodies alone', () => {
    const xml = '<tool_call>\n<function=read_file>\n</function>\n</tool_call>';
    expect(parseStructuredOutput(xml)).toEqual([]);
    expect(stripStructuredOutputFromFullText(xml)).toBe(xml);
  });
});
