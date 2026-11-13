import { describe, expect, it } from 'vitest';
import { forgeMcpToolName, mcpSchemaGaps } from '../../src/tools/mcpProviderContract';

describe('forgeMcpToolName', () => {
  it('leaves a name every backend already accepts exactly as the server wrote it', () => {
    expect(forgeMcpToolName('search_sessions')).toEqual({
      advertised: 'search_sessions',
      external: 'search_sessions',
      mapped: false,
    });
  });

  it('replaces the characters a backend would reject, and says it mapped', () => {
    expect(forgeMcpToolName('vendor.tool.with.dots')).toEqual({
      advertised: 'vendor_tool_with_dots',
      external: 'vendor.tool.with.dots',
      mapped: true,
    });
  });

  it('keeps a name unique in the registry instead of losing the tool to a duplicate', () => {
    const taken = new Set(['search', 'search_2']);
    expect(forgeMcpToolName('search', (candidate) => taken.has(candidate)).advertised).toBe(
      'search_3',
    );
  });

  it('fits the 64-character ceiling and keeps the suffix that makes it unique', () => {
    const long = 'x'.repeat(80);
    const first = forgeMcpToolName(long).advertised;
    expect(first).toHaveLength(64);
    const second = forgeMcpToolName(long, (candidate) => candidate === first).advertised;
    expect(second).toHaveLength(64);
    expect(second.endsWith('_2')).toBe(true);
  });

  it('still names the tool when nothing survives the sanitiser', () => {
    expect(forgeMcpToolName('!!!').advertised).toBe('mcp_tool');
  });
});

describe('mcpSchemaGaps', () => {
  it('reports nothing for a schema constrained decoding can enforce', () => {
    expect(
      mcpSchemaGaps({
        type: 'object',
        properties: { a: { type: 'string', format: 'date' } },
        required: ['a'],
        additionalProperties: false,
        enum: ['oneOf', 'not'],
      }),
    ).toEqual([]);
  });

  it('reports the keywords it has no rule for, and the formats it ignores', () => {
    expect(
      mcpSchemaGaps({
        type: 'object',
        oneOf: [{ type: 'string' }],
        properties: {
          where: { type: 'string', format: 'email' },
          ids: { type: 'array', uniqueItems: true },
        },
      }),
    ).toEqual(['$: oneOf', 'properties.where: format "email"', 'properties.ids: uniqueItems']);
  });

  it('does not read a property named after a keyword as the keyword', () => {
    expect(
      mcpSchemaGaps({
        type: 'object',
        properties: { oneOf: { type: 'string' }, not: { type: 'string' } },
      }),
    ).toEqual([]);
  });
});
