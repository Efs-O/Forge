import { describe, expect, it } from 'vitest';
import { extractTextContent, mcpToolToRegisteredTool } from '../../src/tools/mcpBridge';

describe('extractTextContent', () => {
  it('joins text parts with newlines and ignores non-text parts', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'image', text: 'ignored' },
      { type: 'text', text: 'second' },
    ];
    expect(extractTextContent(content)).toBe('first\nsecond');
  });

  it('returns empty string for undefined or empty content', () => {
    expect(extractTextContent(undefined)).toBe('');
    expect(extractTextContent([])).toBe('');
  });
});

describe('mcpToolToRegisteredTool', () => {
  const tool = {
    name: 'search_sessions',
    description: 'Search archived sessions',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  };

  it('builds a read-permission tool definition from the MCP listing', () => {
    const registered = mcpToolToRegisteredTool('halluscribe', tool, async () => ({ content: [] }));
    expect(registered.permission).toBe('read');
    expect(registered.definition).toEqual({
      type: 'function',
      function: {
        name: 'search_sessions',
        description: 'Search archived sessions',
        parameters: tool.inputSchema,
      },
    });
  });

  it('defaults description to empty string when the MCP tool omits it', () => {
    const registered = mcpToolToRegisteredTool(
      'halluscribe',
      { name: 'x', inputSchema: {} },
      async () => ({ content: [] }),
    );
    expect(registered.definition.function.description).toBe('');
  });

  it('handler returns concatenated text content on success', async () => {
    const registered = mcpToolToRegisteredTool('halluscribe', tool, async () => ({
      content: [
        { type: 'text', text: 'result A' },
        { type: 'text', text: 'result B' },
      ],
    }));
    await expect(registered.handler({ query: 'x' })).resolves.toBe('result A\nresult B');
  });

  it('handler throws with the text content when the MCP call reports isError', async () => {
    const registered = mcpToolToRegisteredTool('halluscribe', tool, async () => ({
      content: [{ type: 'text', text: 'boom: bad input' }],
      isError: true,
    }));
    await expect(registered.handler({ query: 'x' })).rejects.toThrow('boom: bad input');
  });

  it('handler throws a fallback message when isError has no text content', async () => {
    const registered = mcpToolToRegisteredTool('halluscribe', tool, async () => ({
      isError: true,
    }));
    await expect(registered.handler({ query: 'x' })).rejects.toThrow(
      'MCP tool "search_sessions" on server "halluscribe" returned an error',
    );
  });

  it('handler truncates oversized results at the given cap with a visible marker', async () => {
    const registered = mcpToolToRegisteredTool(
      'halluscribe',
      tool,
      async () => ({
        content: [{ type: 'text', text: 'a'.repeat(50) }],
      }),
      10,
    );
    const out = await registered.handler({ query: 'x' });
    expect(out).toBe(
      `${'a'.repeat(10)}\n\n[truncated by Forge MCP bridge — showing 10 of 50 chars]`,
    );
  });
});
