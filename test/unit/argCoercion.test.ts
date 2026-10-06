import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../src/llm/types';
import { coerceToolArgs } from '../../src/tools/argCoercion';

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
});
