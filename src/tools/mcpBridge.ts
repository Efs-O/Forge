import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolPermission, ToolRegistry, RegisteredTool } from './ToolRegistry';
import type { McpServerConfig } from '../config/types';
import type { ToolApprovalMetadata } from './toolContract';
import { hasConversationReadSecret, secretReadCardReason } from './exfilTaint';
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
 * is accepted too, so a mapping never silently drops a permission. A tool that
 * is not listed there asks before each call, and any MCP call in a chat that has
 * read a secret asks the owner, as `web_fetch` does.
 */
export function mcpToolToRegisteredTool(
  serverName: string,
  name: McpToolName,
  tool: McpToolListing,
  callTool: (args: Record<string, unknown>) => Promise<McpCallToolResult>,
  toolPermissions: Record<string, ToolPermission> = {},
  maxResultChars: number = DEFAULT_MAX_RESULT_CHARS,
): RegisteredTool {
  const listed = toolPermissions[name.external] ?? toolPermissions[name.advertised];
  return {
    definition: {
      type: 'function',
      function: {
        name: name.advertised,
        description: tool.description ?? '',
        parameters: (tool.inputSchema ?? {}) as Record<string, unknown>,
      },
    },
    permission: listed ?? 'read',
    /** Every MCP server is a program Forge did not write, and its reply is its
     *  own text — often fetched from the internet by that program — so a bridged
     *  tool's result counts as outside content whatever its name is. Declared
     *  here rather than matched by name, because these names come from the server
     *  and cannot be spelled in advance (`exfilTaint.ts` derives the flag from the
     *  transcript through this same declaration). */
    untrustedResult: true,
    /** The tier above is a guess, not a promise: an unlisted tool gets `read`
     *  because Forge cannot know what the server does with the call. Declared so
     *  the dispatcher never parks this call — parking starts it while its card
     *  waits, and a tool that may write would then be answered over by a later
     *  read in the same round (BL-046). */
    unknownEffects: true,
    /** Whether this call has to ask, decided by `mcpApprovalFor` below: a tool the
     *  user never listed, or any call in a chat that has read a secret. */
    approval: (_args, context) =>
      mcpApprovalFor(serverName, name, listed !== undefined, context?.conversationId),
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
 * The card one MCP call must ask for, in the same order `web_fetch` uses
 * (`fetchHostApprovals.ts`): the secret read first, then the rule the user's
 * config did not already cover.
 *
 * An MCP server is a program Forge did not write, and it may send what it is
 * given anywhere — so a tool the user never named in `tool_permissions` no
 * longer runs on the read tier alone, it asks. It carries no `approvalKey` of
 * its own: `approvalKeysFor` step 4 gives a non-dangerous, kindless tool gate the
 * key `tool:<advertised name>`, so "Allow for this chat" answers it, Clanker may
 * answer it, and an unattended job refuses it until the owner lists that key.
 *
 * A chat that has read a secret pays the owner-only card whatever the tool is,
 * listed or not, and deliberately gets no key: `approvalKeysFor` step 4 fails a
 * dangerous gate with no key closed to the owner every time, and
 * `approvalCallOptions.ts` turns `secretReadTaint` into the Clanker stop that
 * keeps an automated run from answering a secret read on the owner's behalf.
 */
export function mcpApprovalFor(
  serverName: string,
  name: McpToolName,
  listed: boolean,
  conversationId: string | undefined,
): ToolApprovalMetadata | undefined {
  const detail = `MCP server "${serverName}", tool "${name.external}"`;
  if (hasConversationReadSecret(conversationId)) {
    return {
      detail,
      dangerous: true,
      cardReason: secretReadCardReason(conversationId),
      declineHint:
        'tell the owner what you need from this MCP tool; a secret read taints the whole chat',
      gateKind: 'taintGate',
      secretReadTaint: true,
      reachesOut: 'network',
    };
  }
  if (!listed) {
    return {
      detail,
      cardReason: `"${name.external}" is not listed under this server's tool_permissions, so it asks before each call`,
      // `tool_permissions` is read once, when the bridge registers these tools at
      // activation (`toolActivationSetup.ts`), and nothing re-bridges them on a
      // config reload — so the hint has to say that the edit lands only on the
      // next window, or the agent relays it, the owner edits, and the card keeps
      // coming (BL-047). Same convention as `RemoteStarterClient.ts` and
      // `poolStructuralConfig.ts`, which name the reload for the same reason.
      declineHint:
        `ask the owner to list "${name.external}" under tool_permissions for MCP server ` +
        `"${serverName}" in ~/.forge/policy.yaml (config.yaml if the security settings were never ` +
        `moved there), then run "Developer: Reload Window" — that listing is read once when Forge ` +
        `starts, so the card keeps coming until the window reloads`,
    };
  }
  // Listed and nothing tainted in this chat: the permission tier decides, exactly
  // as it did before this gate existed.
  return undefined;
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
    // Set for every server that did not ask to stay advertised: the tools bridge
    // in exactly as before, they just wait behind `load_tool_group`.
    const lazyGroup = lazyGroupForServer(server.name, server.eager === true);
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
