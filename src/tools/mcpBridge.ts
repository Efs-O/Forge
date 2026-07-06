import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolRegistry, RegisteredTool } from './ToolRegistry';
import type { McpServerConfig } from '../config/types';

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
 */
export function mcpToolToRegisteredTool(
  serverName: string,
  tool: McpToolListing,
  callTool: (args: Record<string, unknown>) => Promise<McpCallToolResult>,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: (tool.inputSchema ?? {}) as Record<string, unknown>,
      },
    },
    permission: 'read',
    handler: async (args) => {
      const result = await callTool(args);
      const text = extractTextContent(result.content);
      if (result.isError) {
        throw new Error(text || `MCP tool "${tool.name}" on server "${serverName}" returned an error`);
      }
      return text;
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
    void vscode.window.showWarningMessage(`Forge: MCP server "${server.name}" failed to connect — ${reason}`);
    return undefined;
  }

  try {
    const { tools } = await client.listTools();
    let bridged = 0;
    for (const tool of tools) {
      try {
        registry.register(
          mcpToolToRegisteredTool(server.name, tool, (args) =>
            client.callTool({ name: tool.name, arguments: args }) as Promise<McpCallToolResult>,
          ),
        );
        bridged += 1;
      } catch (err) {
        // ToolRegistry.register throws on a duplicate name — skip that one
        // tool rather than failing the whole server.
        log.warn(`MCP server "${server.name}": skipping tool "${tool.name}" — ${(err as Error).message}`);
      }
    }
    log.info(`MCP server "${server.name}": connected, bridged ${bridged}/${tools.length} tool(s)`);
    return client;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(`MCP server "${server.name}": listTools failed`, err);
    void vscode.window.showWarningMessage(`Forge: MCP server "${server.name}" failed to list tools — ${reason}`);
    await client.close().catch(() => undefined);
    return undefined;
  }
}

/**
 * Connects every configured MCP stdio server and bridges their tools into
 * `registry` (read permission). Runs servers concurrently; one server's
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
