import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../src/llm/types';
import { coerceToolArgs, repairedToolArgumentFields } from '../../src/tools/argCoercion';

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'probe',
    description: 'probe',
    parameters: {
      type: 'object',
      properties: {
        flag: { type: 'boolean' },
        count: { type: 'integer' },
        ratio: { type: 'number' },
        paths: { type: 'array', items: { type: 'string' } },
        questions: { type: 'array', items: { type: 'object' } },
        settings: { type: 'object' },
        command: { type: 'string' },
      },
    },
  },
};

describe('coerceToolArgs', () => {
  it('repairs quoted booleans, numbers and JSON arrays', () => {
    expect(
      coerceToolArgs(definition, {
        flag: 'True',
        count: ' 5 ',
        ratio: '0.5',
        paths: '["a.ts", "b.ts"]',
        command: 'true',
      }),
    ).toEqual({ flag: true, count: 5, ratio: 0.5, paths: ['a.ts', 'b.ts'], command: 'true' });
  });

  it('leaves anything with more than one reading for invalidArgs to refuse', () => {
    const args = { flag: 'yes', count: '1.5', ratio: '1e3', paths: 'a.ts, b.ts' };
    expect(coerceToolArgs(definition, args)).toBe(args);
    expect(coerceToolArgs(definition, { paths: '[not json' })).toEqual({ paths: '[not json' });
    expect(coerceToolArgs(definition, { paths: '{"a":1}' })).toEqual({ paths: '{"a":1}' });
  });

  it('does not mutate the caller object', () => {
    const args = { flag: 'false' };
    expect(coerceToolArgs(definition, args)).toEqual({ flag: false });
    expect(args).toEqual({ flag: 'false' });
  });

  it('repairs an invalid Windows path escape in an ask_user questions array', () => {
    const questions = String.raw`[{"prompt":"Open N:\vs code apps\Forge"}]`;
    const args = coerceToolArgs(definition, { questions });

    expect(args['questions']).toEqual([{ prompt: String.raw`Open N:\vs code apps\Forge` }]);
    expect(repairedToolArgumentFields(args)).toEqual(['questions']);
  });

  it('repairs an invalid Windows path escape in a structured object field', () => {
    const settings = String.raw`{"path":"N:\vs code apps\Forge"}`;
    const args = coerceToolArgs(definition, { settings });

    expect(args['settings']).toEqual({ path: String.raw`N:\vs code apps\Forge` });
    expect(repairedToolArgumentFields(args)).toEqual(['settings']);
  });

  it('leaves doubled backslashes and valid JSON escapes unchanged', () => {
    const paths = String.raw`[{"path":"N:\\vs"}]`;
    const args = coerceToolArgs(definition, { paths });

    expect(args['paths']).toEqual([{ path: String.raw`N:\vs` }]);
    expect(repairedToolArgumentFields(args)).toEqual([]);

    const validEscapes = String.raw`[{"text":"line\n\t\u00e9","path":"N:\vs"}]`;
    const repaired = coerceToolArgs(definition, { paths: validEscapes });
    expect(repaired['paths']).toEqual([{ text: 'line\n\té', path: String.raw`N:\vs` }]);
    expect(repairedToolArgumentFields(repaired)).toEqual(['paths']);
  });

  it('repairs a malformed Unicode escape as a literal backslash', () => {
    const paths = String.raw`[{"text":"\u12","path":"N:\vs"}]`;
    const args = coerceToolArgs(definition, { paths });

    expect(args['paths']).toEqual([{ text: String.raw`\u12`, path: String.raw`N:\vs` }]);
    expect(repairedToolArgumentFields(args)).toEqual(['paths']);
  });

  it('does not turn a valid JSON object string into an object', () => {
    const args = { settings: '{"mode":"fast"}' };

    expect(coerceToolArgs(definition, args)).toBe(args);
  });
});
