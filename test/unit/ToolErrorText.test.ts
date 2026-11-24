import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { brokenJsonArgumentMismatch, toolErrorText } from '../../src/tools/toolErrorText';

describe('toolErrorText enum issues', () => {
  it('names the allowed values and the received value', () => {
    const schema = z.object({ agent: z.enum(['claude', 'codex', 'copilot']) });
    const parsed = schema.safeParse({ agent: 'local' });
    if (parsed.success) throw new Error('Expected the enum value to be rejected.');

    expect(toolErrorText('ask_agent', parsed.error, { agent: 'local' })).toBe(
      'Error: ask_agent agent must be one of "claude", "codex", "copilot"; received "local".',
    );
  });
});

/**
 * The mistake that cost a whole round trip in session 0dd5c224: `apply_line_edits`
 * got an `operations` array one `]` short, so it arrived as a string and the
 * refusal said "must be a JSON array, not a string" — untrue, and the retry was
 * the same broken text. The new sentence names the character it broke at.
 */
describe('brokenJsonArgumentMismatch', () => {
  /** Node's own parse message, so the test does not hard-code its wording. */
  const parseMessage = (value: string): string => {
    try {
      JSON.parse(value);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error(`Expected ${value} not to parse.`);
  };

  it('names the character where a broken array stops parsing', () => {
    const value = '[{"a": ["x"}]';
    const message = parseMessage(value);
    const pos = Number(/at position (\d+)/u.exec(message)?.[1]);
    expect(pos).toBe(11);
    expect(brokenJsonArgumentMismatch('apply_line_edits', 'operations', 'array', value)).toBe(
      'Error: apply_line_edits: "operations" was written as a JSON array but is not valid JSON, ' +
        `so it arrived as a string and nothing ran. The parser stopped at character ${pos}: ` +
        `${message}. The text just before that point is ` +
        `${JSON.stringify('[{"a": ["x"}')}. Check the brackets and quotes there, then resend ` +
        'the call with operations as one valid JSON array.',
    );
  });

  it('names the character where a broken object stops parsing', () => {
    const value = '{"a": 1';
    const message = parseMessage(value);
    const pos = Number(/at position (\d+)/u.exec(message)?.[1]);
    expect(pos).toBe(7);
    expect(brokenJsonArgumentMismatch('manage_jobs', 'definition', 'object', value)).toBe(
      'Error: manage_jobs: "definition" was written as a JSON object but is not valid JSON, ' +
        `so it arrived as a string and nothing ran. The parser stopped at character ${pos}: ` +
        `${message}. The text just before that point is ` +
        `${JSON.stringify('{"a": 1')}. Check the brackets and quotes there, then resend ` +
        'the call with definition as one valid JSON object.',
    );
  });

  it('says only what the parser said when its message carries no position', () => {
    const message = parseMessage('[');
    expect(/at position/u.test(message)).toBe(false);
    expect(brokenJsonArgumentMismatch('apply_line_edits', 'operations', 'array', '[')).toBe(
      'Error: apply_line_edits: "operations" was written as a JSON array but is not valid JSON, ' +
        `so it arrived as a string and nothing ran. The parser said: ${message}. ` +
        'Check the brackets and quotes, then resend the call with operations as one valid JSON array.',
    );
  });

  it('returns undefined for a string that parses, one that is no shape, and a number', () => {
    // A valid stringified array keeps today's refusal: it really is a string.
    expect(brokenJsonArgumentMismatch('apply_line_edits', 'operations', 'array', '[1,2]')).toBeUndefined();
    expect(brokenJsonArgumentMismatch('apply_line_edits', 'operations', 'array', 'abc')).toBeUndefined();
    expect(brokenJsonArgumentMismatch('apply_line_edits', 'operations', 'array', 5)).toBeUndefined();
    expect(brokenJsonArgumentMismatch('manage_jobs', 'definition', 'object', '{"a":1}')).toBeUndefined();
    // A field that does not expect a container is none of this function's business.
    expect(brokenJsonArgumentMismatch('read_file', 'end_line', 'integer', '[1]')).toBeUndefined();
  });
});
