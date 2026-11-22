import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { ForgeConfigSchema } from '../../src/config/schema';
import {
  connectMcpServers,
  extractTextContent,
  mcpApprovalFor,
  mcpToolToRegisteredTool,
} from '../../src/tools/mcpBridge';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { McpToolName } from '../../src/tools/mcpProviderContract';
import {
  clearConversationExfilState,
  markConversationReadSecret,
  markConversationReadUntrusted,
  secretReadCardReason,
} from '../../src/tools/exfilTaint';

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

  it('declares that a bridged tool may change anything, so the dispatcher will not park it (BL-046)', () => {
    const registered = mcpToolToRegisteredTool(
      'files',
      pair('delete_all'),
      {
        name: 'delete_all',
        description: 'Delete every file under the folder',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      async () => ({ content: [] }),
    );
    // The tier is the bridge's guess and the reason parking has to be refused:
    // an unlisted tool is `read` only because Forge cannot know what the server does.
    expect(registered.permission).toBe('read');
    expect(registered.unknownEffects).toBe(true);
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

describe('mcpApprovalFor', () => {
  afterEach(() => {
    clearConversationExfilState('c1');
  });

  /** The owner-only card a secret read puts on any MCP call, listed or not. */
  const secretCard = (): Record<string, unknown> => ({
    detail: 'MCP server "files", tool "delete_all"',
    dangerous: true,
    cardReason: secretReadCardReason('c1'),
    declineHint:
      'tell the owner what you need from this MCP tool; a secret read taints the whole chat',
    gateKind: 'taintGate',
    secretReadTaint: true,
    reachesOut: 'network',
  });

  it('asks for an unlisted tool in a clean chat, with no key of its own', () => {
    expect(mcpApprovalFor('files', pair('delete_all'), false, 'c1')).toEqual({
      detail: 'MCP server "files", tool "delete_all"',
      cardReason:
        '"delete_all" is not listed under this server\'s tool_permissions, so it asks before each call',
      declineHint:
        'ask the owner to list "delete_all" under tool_permissions for MCP server "files" in ~/.forge/policy.yaml (config.yaml if the security settings were never moved there), then run "Developer: Reload Window" \u2014 that listing is read once when Forge starts, so the card keeps coming until the window reloads',
    });
  });

  it('asks nothing of a listed tool in a clean chat', () => {
    expect(mcpApprovalFor('files', pair('search'), true, 'c1')).toBeUndefined();
  });

  it('asks nothing of a listed tool in a chat that read web pages but no secret', () => {
    markConversationReadUntrusted('c1');
    expect(mcpApprovalFor('files', pair('search'), true, 'c1')).toBeUndefined();
  });

  it('asks the owner for a listed tool once this chat has read a secret', () => {
    markConversationReadSecret('c1', '.env', 'cat .env');
    expect(mcpApprovalFor('files', pair('delete_all'), true, 'c1')).toEqual(secretCard());
  });

  it('raises the secret card, not the unlisted one, when both apply', () => {
    markConversationReadSecret('c1', '.env', 'cat .env');
    expect(mcpApprovalFor('files', pair('delete_all'), false, 'c1')).toEqual(secretCard());
  });

  it('still asks an unlisted tool with no conversation to judge', () => {
    expect(mcpApprovalFor('files', pair('delete_all'), false, undefined)).toEqual({
      detail: 'MCP server "files", tool "delete_all"',
      cardReason:
        '"delete_all" is not listed under this server\'s tool_permissions, so it asks before each call',
      declineHint:
        'ask the owner to list "delete_all" under tool_permissions for MCP server "files" in ~/.forge/policy.yaml (config.yaml if the security settings were never moved there), then run "Developer: Reload Window" \u2014 that listing is read once when Forge starts, so the card keeps coming until the window reloads',
    });
  });

  it('reads tool_permissions by the advertised name through a mapped name, and asks when that tool is unlisted', () => {
    const mapped: McpToolName = { advertised: 'my_tool', external: 'my.tool', mapped: true };
    const listed = mcpToolToRegisteredTool(
      'files',
      mapped,
      { name: 'my.tool', inputSchema: {} },
      async () => ({ content: [] }),
      { my_tool: 'read' },
    );
    expect(listed.approval!({}, { conversationId: 'c1' })).toBeUndefined();

    const unlisted = mcpToolToRegisteredTool(
      'files',
      mapped,
      { name: 'my.tool', inputSchema: {} },
      async () => ({ content: [] }),
      {},
    );
    expect(unlisted.approval!({}, { conversationId: 'c1' })).toEqual({
      detail: 'MCP server "files", tool "my.tool"',
      cardReason:
        '"my.tool" is not listed under this server\'s tool_permissions, so it asks before each call',
      declineHint:
        'ask the owner to list "my.tool" under tool_permissions for MCP server "files" in ~/.forge/policy.yaml (config.yaml if the security settings were never moved there), then run "Developer: Reload Window" \u2014 that listing is read once when Forge starts, so the card keeps coming until the window reloads',
    });
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
