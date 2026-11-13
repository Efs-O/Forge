import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolPermission, ToolRegistry, RegisteredTool } from './ToolRegistry';
import type { McpServerConfig } from '../config/types';
import { DEFAULT_MAX_RESULT_CHARS, capResultText } from './resultCap';
import { lazyGroupForServer, recordLazyGroupTool } from './lazyToolGroups';
import { forgeMcpToolName, mcpSchemaGaps, type McpToolName } from './mcpProviderContract';

/** Minimal logging surface — matches util/logger's Logger so callers can pass getLogger() directly. */
export interface McpBridgeLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

/** Subset of an MCP tool listing entry this bridge cares about. */
export interface McpToolListing {
  name: string;
  description?: string | undefined;
  inputSchema: unknown;
}

/** Subset of an MCP callTool result this bridge cares about. */
export interface McpCallToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** Joins every text content part (in order) with newlines; ignores non-text parts. */
export function extractTextContent(content: McpCallToolResult['content']): string {
  if (!content) return '';
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

/**
 * Converts one MCP tool listing into a Forge RegisteredTool. Pure aside from
 * the injected `callTool`, so it is testable without spawning a real server.
 *
 * `name` is the provider-facing pair: the advertised name is what the model is
 * told and what the registry dispatches, while `callTool` receives the name the
 * server itself used. `tool_permissions` is keyed by the server's own name,
 * because that is the name the user writes in their config; the advertised name
 * is accepted too, so a mapping never silently drops a permission.
 */
export function mcpToolToRegisteredTool(
  serverName: string,
  name: McpToolName,
  tool: McpToolListing,
  callTool: (args: Record<string, unknown>) => Promise<McpCallToolResult>,
  toolPermissions: Record<string, ToolPermission> = {},
  maxResultChars: number = DEFAULT_MAX_RESULT_CHARS,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: name.advertised,
        description: tool.description ?? '',
        parameters: (tool.inputSchema ?? {}) as Record<string, unknown>,
      },
    },
    permission: toolPermissions[name.external] ?? toolPermissions[name.advertised] ?? 'read',
    /** Every MCP server is a program Forge did not write, and its reply is its
     *  own text — often fetched from the internet by that program — so a bridged
     *  tool's result counts as outside content whatever its name is. Declared
     *  here rather than matched by name, because these names come from the server
     *  and cannot be spelled in advance (`exfilTaint.ts` derives the flag from the
     *  transcript through this same declaration). */
    untrustedResult: true,
    handler: async (args) => {
      const result = await callTool(args);
      const text = extractTextContent(result.content);
      if (result.isError) {
        throw new Error(
          text || `MCP tool "${tool.name}" on server "${serverName}" returned an error`,
        );
      }
      return capResultText(text, maxResultChars);
    },
  };
}

/**
 * Connects to one external MCP stdio server and bridges its tools into the
 * registry. Never throws — connection and per-tool failures are logged (and,
 * for a failed connection, surfaced as a one-shot warning toast) so a bad
 * server never blocks the others or the extension.
 */
async function connectOne(
  server: McpServerConfig,
  registry: ToolRegistry,
  log: McpBridgeLogger,
): Promise<Client | undefined> {
  let client: Client;
  try {
    const transport = new StdioClientTransport(
      server.args ? { command: server.command, args: server.args } : { command: server.command },
    );
    client = new Client({ name: `forge-mcp-bridge-${server.name}`, version: '1.0.0' });
    await client.connect(transport);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(`MCP server "${server.name}": failed to connect`, err);
    void vscode.window.showWarningMessage(
      `Forge: MCP server "${server.name}" failed to connect — ${reason}`,
    );
    return undefined;
  }

  try {
    const { tools } = await client.listTools();
    // Set only for a server whose schemas are demand-loaded; every other
    // server bridges in exactly as before.
    const lazyGroup = lazyGroupForServer(server.name);
    let bridged = 0;
    for (const tool of tools) {
      // The server's own name may be one no backend accepts, or one another
      // server already answered to. Both are mapped; the call below still uses
      // the server's name, so the mapping is invisible to the server.
      const name = forgeMcpToolName(
        tool.name,
        (candidate) => registry.get(candidate) !== undefined,
      );
      if (name.mapped) {
        log.info(
          `MCP server "${server.name}": advertising "${name.advertised}" for "${name.external}" ` +
            '(the server name is not one every backend accepts, or it is already taken)',
        );
      }
      const gaps = mcpSchemaGaps(tool.inputSchema);
      if (gaps.length > 0) {
        log.warn(
          `MCP server "${server.name}" tool "${name.advertised}": constrained decoding does not ` +
            `enforce ${gaps.join('; ')} — the model may send anything there`,
        );
      }
      try {
        registry.register(
          mcpToolToRegisteredTool(
            server.name,
            name,
            tool,
            (args) =>
              client.callTool({
                name: name.external,
                arguments: args,
              }) as Promise<McpCallToolResult>,
            server.tool_permissions,
            server.max_result_chars ?? DEFAULT_MAX_RESULT_CHARS,
          ),
        );
        // After register(): a duplicate name throws above, and a tool that is
        // not in the registry must never be counted as a hideable member.
        if (lazyGroup) recordLazyGroupTool(lazyGroup, name.advertised);
        bridged += 1;
      } catch (err) {
        // ToolRegistry.register throws on a duplicate name — skip that one
        // tool rather than failing the whole server.
        log.warn(
          `MCP server "${server.name}": skipping tool "${name.external}" — ${(err as Error).message}`,
        );
      }
    }
    log.info(`MCP server "${server.name}": connected, bridged ${bridged}/${tools.length} tool(s)`);
    return client;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(`MCP server "${server.name}": listTools failed`, err);
    void vscode.window.showWarningMessage(
      `Forge: MCP server "${server.name}" failed to list tools — ${reason}`,
    );
    await client.close().catch(() => undefined);
    return undefined;
  }
}

/**
 * Connects every configured MCP stdio server and bridges their tools into
 * `registry` using each server's configured per-tool permission (read by
 * default). Runs servers concurrently; one server's
 * failure never blocks the others. Returns a disposable that closes every
 * successfully-connected client (which kills its child process).
 *
 * Callers should invoke this as a non-blocking background task — it is async
 * because it spawns processes and performs a handshake per server, and
 * `ToolRegistry.definitions()` is re-read every agent turn, so bridged tools
 * simply appear once this resolves.
 */
export async function connectMcpServers(
  servers: McpServerConfig[],
  registry: ToolRegistry,
  log: McpBridgeLogger,
): Promise<vscode.Disposable> {
  const clients = await Promise.all(servers.map((server) => connectOne(server, registry, log)));
  const connected = clients.filter((c): c is Client => c !== undefined);

  return {
    dispose(): void {
      for (const client of connected) {
        void client.close().catch(() => undefined);
      }
    },
  };
}
