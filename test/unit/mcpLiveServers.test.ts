import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { McpServerConfig } from '../../src/config/types';
import { ALL_TOOL_PERMISSIONS } from '../../src/tools/toolContract';
import { connectMcpServers } from '../../src/tools/mcpBridge';
import { ToolRegistry } from '../../src/tools/ToolRegistry';

vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn() },
}));

/** Only runs when asked for: it spawns the servers this machine configures, so
 *  CI never depends on Blender being open. `FORGE_LIVE_MCP=1 npm test` runs it. */
const LIVE = process.env.FORGE_LIVE_MCP === '1';

function configuredServers(): McpServerConfig[] {
  try {
    const doc = parse(readFileSync(join(homedir(), '.forge', 'policy.yaml'), 'utf8')) as {
      mcp_servers?: McpServerConfig[];
    };
    return doc?.mcp_servers ?? [];
  } catch {
    return [];
  }
}

const ALL_PERMISSIONS = new Set(ALL_TOOL_PERMISSIONS);

describe.skipIf(!LIVE)('the MCP servers this machine actually configures', () => {
  it(
    'bridges every advertised name into a shape every backend accepts',
    async () => {
      const servers = configuredServers();
      expect(servers.length).toBeGreaterThan(0);

      const registry = new ToolRegistry();
      const logLines: string[] = [];
      const log = {
        info: (msg: string): void => void logLines.push(`info: ${msg}`),
        warn: (msg: string): void => void logLines.push(`warn: ${msg}`),
        error: (msg: string, err?: unknown): void =>
          void logLines.push(`error: ${msg} ${err instanceof Error ? err.message : String(err)}`),
      };

      const connection = await connectMcpServers(
        servers,
        registry,
        log as unknown as Parameters<typeof connectMcpServers>[2],
      );
      let advertised: string[] = [];
      try {
        advertised = registry
          .definitions(ALL_PERMISSIONS)
          .map((definition) => definition.function.name);
      } finally {
        connection.dispose();
      }

      const evidence = {
        ran_at: new Date().toISOString(),
        servers: servers.map((server) => ({ name: server.name, command: server.command })),
        log_lines: logLines,
        advertised,
      };
      const evidenceDir = resolve('docs/reports/mcp-live-2026-11-13');
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, 'evidence.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8',
      );

      // Every name that reached the model is one every backend accepts; a dotted
      // or unicode name here means the boundary leaked it through.
      expect(advertised.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true);
    },
    180_000,
  );
});
