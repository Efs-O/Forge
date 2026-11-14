import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { ForgeConfigSchema } from '../../src/config/schema';
import {
  connectMcpServers,
  extractTextContent,
  mcpToolToRegisteredTool,
} from '../../src/tools/mcpBridge';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { McpToolName } from '../../src/tools/mcpProviderContract';

/** The bridge's provider-facing pair for a name that needs no mapping. */
function pair(name: string): McpToolName {
  return { advertised: name, external: name, mapped: false };
}

const testLog = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

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

  it('assigns a configured delegate permission to a bridged tool', () => {
    const registered = mcpToolToRegisteredTool(
      'forgerelay',
      pair('search_sessions'),
      tool,
      async () => ({ content: [] }),
      {
        search_sessions: 'delegate',
      },
    );
    expect(registered.permission).toBe('delegate');
  });

  it('defaults an unlisted bridged tool to read permission', () => {
    const registered = mcpToolToRegisteredTool(
      'halluscribe',
      pair('search_sessions'),
      tool,
      async () => ({ content: [] }),
    );
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
      pair('x'),
      { name: 'x', inputSchema: {} },
      async () => ({ content: [] }),
    );
    expect(registered.definition.function.description).toBe('');
  });

  it('handler returns concatenated text content on success', async () => {
    const registered = mcpToolToRegisteredTool(
      'halluscribe',
      pair('search_sessions'),
      tool,
      async () => ({
        content: [
          { type: 'text', text: 'result A' },
          { type: 'text', text: 'result B' },
        ],
      }),
    );
    await expect(registered.handler({ query: 'x' })).resolves.toBe('result A\nresult B');
  });

  it('handler throws with the text content when the MCP call reports isError', async () => {
    const registered = mcpToolToRegisteredTool(
      'halluscribe',
      pair('search_sessions'),
      tool,
      async () => ({
        content: [{ type: 'text', text: 'boom: bad input' }],
        isError: true,
      }),
    );
    await expect(registered.handler({ query: 'x' })).rejects.toThrow('boom: bad input');
  });

  it('handler throws a fallback message when isError has no text content', async () => {
    const registered = mcpToolToRegisteredTool(
      'halluscribe',
      pair('search_sessions'),
      tool,
      async () => ({
        isError: true,
      }),
    );
    await expect(registered.handler({ query: 'x' })).rejects.toThrow(
      'MCP tool "search_sessions" on server "halluscribe" returned an error',
    );
  });

  it('handler truncates oversized results at the given cap with a visible marker', async () => {
    const registered = mcpToolToRegisteredTool(
      'halluscribe',
      pair('search_sessions'),
      tool,
      async () => ({
        content: [{ type: 'text', text: 'a'.repeat(50) }],
      }),
      {},
      10,
    );
    const out = await registered.handler({ query: 'x' });
    expect(out).toBe(
      `${'a'.repeat(10)}\n\n[truncated by Forge MCP bridge — showing 10 of 50 chars]`,
    );
  });

  it('hides and blocks delegate tools unless delegate permission is granted', async () => {
    const registry = new ToolRegistry();
    registry.register(
      mcpToolToRegisteredTool(
        'forgerelay',
        pair('dispatch_subagent'),
        { name: 'dispatch_subagent', inputSchema: { type: 'object' } },
        async () => ({ content: [{ type: 'text', text: 'delegated result' }] }),
        { dispatch_subagent: 'delegate' },
      ),
    );

    expect(registry.definitions(new Set(['read']))).toEqual([]);
    expect(registry.definitions(new Set(['delegate']))).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: 'dispatch_subagent' }) }),
    ]);
    await expect(registry.dispatch('dispatch_subagent', {}, new Set(['read']))).rejects.toThrow(
      'is not available in this conversation',
    );
    await expect(registry.dispatch('dispatch_subagent', {}, new Set(['delegate']))).resolves.toBe(
      'delegated result',
    );
  });

  it('hides and blocks default read-classified tools without read permission', async () => {
    const registry = new ToolRegistry();
    registry.register(
      mcpToolToRegisteredTool('halluscribe', pair('search_sessions'), tool, async () => ({
        content: [{ type: 'text', text: 'result' }],
      })),
    );
    expect(registry.definitions(new Set(['delegate']))).toEqual([]);
    await expect(
      registry.dispatch('search_sessions', { query: 'x' }, new Set(['delegate'])),
    ).rejects.toThrow('is not available in this conversation');
    await expect(
      registry.dispatch('search_sessions', { query: 'x' }, new Set(['read'])),
    ).resolves.toBe('result');
  });

  it('enforces delegate permission after bridging a real stdio MCP server', async () => {
    const registry = new ToolRegistry();
    const connection = await connectMcpServers(
      [
        {
          name: 'stub-delegation-server',
          command: process.execPath,
          args: [resolve(process.cwd(), 'test/fixtures/mcp-delegate-server.mjs')],
          tool_permissions: { dispatch_subagent: 'delegate' },
        },
      ],
      registry,
      testLog,
    );

    try {
      expect(registry.definitions(new Set(['read']))).toEqual([]);
      await expect(registry.dispatch('dispatch_subagent', {}, new Set(['read']))).rejects.toThrow(
        'is not available in this conversation',
      );
      await expect(registry.dispatch('dispatch_subagent', {}, new Set(['delegate']))).resolves.toBe(
        'delegated result',
      );
    } finally {
      connection.dispose();
    }
  });
});

describe('MCP tool permission config validation', () => {
  it('rejects invalid tool permission values', () => {
    const result = ForgeConfigSchema.safeParse({
      active_model: 'local-model',
      llama_server: { binary: 'llama-server' },
      models: [{ name: 'local-model', gguf_path: 'C:/models/local.gguf' }],
      mcp_servers: [
        {
          name: 'forgerelay',
          command: 'forgerelay-mcp',
          tool_permissions: { dispatch_subagent: 'unrestricted' },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('MCP tool permission must be one of');
    }
  });

  it('accepts `eager: true` on a server and refuses a non-boolean for it', () => {
    const base = {
      active_model: 'local-model',
      llama_server: { binary: 'llama-server' },
      models: [{ name: 'local-model', gguf_path: 'C:/models/local.gguf' }],
    };
    const accepted = ForgeConfigSchema.safeParse({
      ...base,
      mcp_servers: [{ name: 'blender', command: 'uvx', args: ['mcp-for-blender'], eager: true }],
    });
    expect(accepted.success).toBe(true);

    const refused = ForgeConfigSchema.safeParse({
      ...base,
      mcp_servers: [{ name: 'blender', command: 'uvx', eager: 'yes' }],
    });
    expect(refused.success).toBe(false);
  });
});

describe('the provider-facing boundary of a real stdio server', () => {
  it('advertises a safe name, calls the server by its own, and logs what decoding will not enforce', async () => {
    const registry = new ToolRegistry();
    const lines: string[] = [];
    const log = {
      info: (msg: string): void => {
        lines.push(`info ${msg}`);
      },
      warn: (msg: string): void => {
        lines.push(`warn ${msg}`);
      },
      error: (msg: string): void => {
        lines.push(`error ${msg}`);
      },
    };
    const connection = await connectMcpServers(
      [
        {
          name: 'boundary',
          command: process.execPath,
          args: [resolve(process.cwd(), 'test/fixtures/mcp-name-boundary-server.mjs')],
        },
      ],
      registry,
      log,
    );

    try {
      expect(registry.definitions(new Set(['read'])).map((d) => d.function.name)).toEqual([
        'vendor_tool_with_dots',
        'ok_name',
      ]);
      // The server's dotted name never reaches the model, yet it is still the
      // name the server is called by.
      await expect(registry.dispatch('vendor_tool_with_dots', {}, new Set(['read']))).resolves.toBe(
        'called:vendor.tool.with.dots',
      );
      expect(
        lines.some((line) =>
          line.includes('advertising "vendor_tool_with_dots" for "vendor.tool.with.dots"'),
        ),
      ).toBe(true);
      // One warning, naming the format the engine will not enforce. The other
      // tool's property merely NAMED `oneOf` is not reported as the keyword.
      expect(lines.filter((line) => line.startsWith('warn'))).toHaveLength(1);
      expect(lines.join('\n')).toContain('format "email"');
    } finally {
      connection.dispose();
    }
  });
});
