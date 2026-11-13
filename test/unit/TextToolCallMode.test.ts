import { describe, expect, it } from 'vitest';
import {
  parseStructuredOutput,
  stripStructuredOutputFromFullText,
  StructuredOutputStripper,
} from '../../src/tools/StructuredOutputParser';
import {
  nativeOnlyToolCalls,
  NATIVE_ONLY_PARSE_ERROR,
  textToolCallForms,
} from '../../src/tools/TextToolCallMode';

const FENCE = '```json\n{"tool": "write_file", "arguments": {"path": "a"}}\n```';
const HERMES = '<tool_call>{"name": "write_file", "arguments": {"path": "a"}}</tool_call>';
const NAMES = new Set(['write_file']);

describe('textToolCallForms', () => {
  it('reads no fenced JSON in a round that offered native tools', () => {
    expect(textToolCallForms(undefined, true)).toEqual({ jsonFence: false, markers: true });
  });

  it('reads every shape in a round that had to fall back to text', () => {
    expect(textToolCallForms(undefined, false)).toEqual({ jsonFence: true, markers: true });
  });

  it('keeps fenced JSON for a model that says its backend ignores native tools', () => {
    expect(textToolCallForms({ text_tool_calls: 'text' }, true)).toEqual({
      jsonFence: true,
      markers: true,
    });
  });

  it('reads nothing at all for a model that wants native events only', () => {
    expect(textToolCallForms({ text_tool_calls: 'native' }, false)).toEqual({
      jsonFence: false,
      markers: false,
    });
  });
});

describe('the forms switch inside the parser', () => {
  it('a fenced example is not a call when the fence is off', () => {
    const forms = textToolCallForms(undefined, true);
    expect(parseStructuredOutput(FENCE, NAMES, forms)).toEqual([]);
    expect(stripStructuredOutputFromFullText(FENCE, NAMES, forms)).toBe(FENCE);
  });

  it('the same fence is a call when the round fell back to text', () => {
    const forms = textToolCallForms(undefined, false);
    expect(parseStructuredOutput(FENCE, NAMES, forms)).toEqual([
      { name: 'write_file', arguments: { path: 'a' } },
    ]);
    expect(stripStructuredOutputFromFullText(FENCE, NAMES, forms)).toBe('');
  });

  it('marker forms stay live in a native round', () => {
    const forms = textToolCallForms(undefined, true);
    expect(parseStructuredOutput(HERMES, NAMES, forms)).toEqual([
      { name: 'write_file', arguments: { path: 'a' } },
    ]);
  });

  it('nothing is a call, and nothing is hidden, when the model wants native only', () => {
    const forms = textToolCallForms({ text_tool_calls: 'native' }, false);
    expect(parseStructuredOutput(`${FENCE}\n${HERMES}`, NAMES, forms)).toEqual([]);
    expect(stripStructuredOutputFromFullText(HERMES, NAMES, forms)).toBe(HERMES);
    const stripper = new StructuredOutputStripper(forms);
    expect(stripper.push(HERMES) + stripper.flush()).toBe(HERMES);
  });
});

describe('nativeOnlyToolCalls', () => {
  it('is true only for the explicit native-only setting', () => {
    expect(nativeOnlyToolCalls({ text_tool_calls: 'native' })).toBe(true);
    expect(nativeOnlyToolCalls({ text_tool_calls: 'text' })).toBe(false);
    expect(nativeOnlyToolCalls({ text_tool_calls: 'auto' })).toBe(false);
    expect(nativeOnlyToolCalls({})).toBe(false);
    expect(nativeOnlyToolCalls(undefined)).toBe(false);
  });

  it('the message the user sees names the setting that caused it', () => {
    expect(NATIVE_ONLY_PARSE_ERROR).toContain('text_tool_calls: native');
    expect(NATIVE_ONLY_PARSE_ERROR).toContain('did not retry');
  });
});
