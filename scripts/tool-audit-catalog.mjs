import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let registrySnapshotPromise;

export async function extractToolAuditSnapshot() {
  registrySnapshotPromise ??= (async () => {
    const outputDirectory = path.join(ROOT, '.test-tmp');
    fs.mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, `tool-audit-registry-${process.pid}.cjs`);
    await esbuild.build({
      entryPoints: [path.join(ROOT, 'scripts/tool-audit-registry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      write: true,
      outfile: outputFile,
      alias: { vscode: path.join(ROOT, 'test/support/vscode.ts') },
      external: ['playwright-core', 'node:*'],
      loader: { '.sh': 'text', '.ps1': 'text' },
      logLevel: 'silent',
    });
    try {
      const module = await import(`${pathToFileURL(outputFile).href}?run=${Date.now()}`);
      return module.buildToolAuditSnapshot();
    } finally {
      fs.rmSync(outputFile, { force: true });
    }
  })();
  return registrySnapshotPromise;
}

export async function extractToolDefinitions() {
  return (await extractToolAuditSnapshot()).definitions;
}

export async function discoverMcpDefinitions(configPath, nativeNames) {
  const document = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const servers = Array.isArray(document?.mcp_servers) ? document.mcp_servers : [];
  const definitions = [];
  const clients = [];
  try {
    for (const server of servers) {
      if (!server || typeof server.name !== 'string' || typeof server.command !== 'string') {
        throw new Error('Invalid MCP server config: name and command are required');
      }
      const transport = new StdioClientTransport(
        Array.isArray(server.args)
          ? { command: server.command, args: server.args, stderr: 'pipe' }
          : { command: server.command, stderr: 'pipe' },
      );
      transport.stderr?.on('data', () => undefined);
      const client = new Client({ name: 'forge-tool-audit', version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        if (
          nativeNames.has(tool.name) ||
          definitions.some((item) => item.function.name === tool.name)
        ) {
          console.warn(`MCP ${server.name}: skipping duplicate tool name ${tool.name}`);
          continue;
        }
        definitions.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description ?? '',
            parameters: tool.inputSchema ?? {},
          },
          source: `mcp:${server.name}`,
          origin: 'mcp',
          factory: 'mcpToolToRegisteredTool',
          permission: server.tool_permissions?.[tool.name] ?? 'read',
        });
      }
    }
    return definitions;
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }
}

export function readJsonEvidence(filename) {
  return filename ? JSON.parse(fs.readFileSync(filename, 'utf8')) : undefined;
}

export function writeCoverageReport(filename, definitions, modelEvidence, capabilityEvidence) {
  const testRoot = path.join(ROOT, 'test');
  const testSources = fs
    .readdirSync(testRoot, { recursive: true })
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.test.ts'))
    .map((entry) => fs.readFileSync(path.join(testRoot, entry), 'utf8'));
  const modelResults = new Map(
    (modelEvidence?.results ?? []).map((result) => [result.tool, result.ok === true]),
  );
  const liveCalls = new Set(
    (capabilityEvidence?.results ?? []).flatMap((result) => [
      ...(result.calls ?? []),
      ...(result.readCalls ?? []),
      ...(result.writeCalls ?? []),
    ]),
  );
  const rows = definitions.map((definition) => {
    const name = definition.function.name;
    const handlerTest = testSources.some((source) => source.includes(name));
    const effect = sideEffect(definition);
    const modelStatus = modelResults.has(name)
      ? modelResults.get(name)
        ? 'passed'
        : 'failed'
      : 'harness';
    const liveStatus = liveCalls.has(name)
      ? 'handler passed'
      : modelResults.get(name)
        ? 'schema passed'
        : 'opt-in';
    return `| ${name} | ${definition.origin} | ${definition.permission} | ${modelStatus} | ${handlerTest ? 'automated' : 'missing'} | ${liveStatus} | ${effect} |`;
  });
  const markdown = [
    '# Forge Tool Coverage Matrix',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'This matrix covers native tools only; MCP servers are not started during generation. The inventory and permissions come from the live registry built by `registerAllTools.ts`. “Harness” means schema emission is available but not executed by default.',
    '',
    '| Tool | Origin | Permission | Model schema test | Handler test | Live test | Side effect |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, markdown, 'utf8');
}

function sideEffect(definition) {
  if (definition.origin === 'mcp') return 'external process';
  const effects = {
    read: 'read-only',
    write: 'write',
    delete: 'delete',
    terminal: 'terminal',
    headless: 'headless',
    search: 'search',
    fetch: 'fetch',
    'git-read': 'read-only',
    'git-write': 'git-write',
    browser: 'browser',
    desktop: 'desktop',
    delegate: 'delegate',
  };
  if (!Object.hasOwn(effects, definition.permission)) {
    throw new Error(
      `Coverage matrix does not know permission ${definition.permission} for ${definition.function.name}`,
    );
  }
  return effects[definition.permission];
}
