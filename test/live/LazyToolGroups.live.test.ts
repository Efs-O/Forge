// Live model test for native and MCP demand-loaded groups (lazyToolGroups.ts).
//
// The unit tests prove the mechanism. The open question this answers is
// behavioural: from compact group/tool descriptions alone, does Qwen3.8 load
// the right family only when a task needs it?
//
// Requires a vision-capable Qwen3.8 model, browser/desktop permissions, and the
// real HalluScribe MCP server from .forge/config.yaml. Set FORGE_LIVE_MODEL to a
// vision model; checks dispatch real tool schemas from all seven groups.
//
//   FORGE_LIVE_LAZY_TOOLS=1 npx vitest run test/live/LazyToolGroups.live.test.ts
//
// Each prompt requests a read-only operation. Browser/desktop permissions are
// present only so their real schemas can participate in the supervised run.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import type * as vscode from 'vscode';
import { loadConfig } from '../../src/config/ConfigLoader';
import type { ForgeConfig } from '../../src/config/types';
import { connectMcpServers } from '../../src/tools/mcpBridge';
import { registerAllTools } from '../../src/tools/registerAllTools';
import {
  hiddenLazyToolNames,
  isLazyGroupAvailable,
  resetLazyToolGroups,
} from '../../src/tools/lazyToolGroups';
import { ToolRegistry, type ToolPermission } from '../../src/tools/ToolRegistry';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import type { IndexManager } from '../../src/search/IndexManager';
import type { ToolDefinition } from '../../src/llm/types';
import { runLiveToolLoop } from './liveModelHarness';

const LIVE = process.env['FORGE_LIVE_LAZY_TOOLS'] === '1';
const ENDPOINT = process.env['FORGE_LIVE_ENDPOINT'] ?? 'http://127.0.0.1:8080';
const MODEL = process.env['FORGE_LIVE_MODEL'] ?? 'qwen38-27b-mtp-ud-q3kxl-no-vision';
const ROOT = path.resolve(__dirname, '../..');

const HALLUSCRIBE_TOOLS = [
  'search_sessions',
  'search_raw_transcripts',
  'read_session',
  'read_raw_session',
  'get_profile',
  'get_digest',
];

// Non-mutating tiers only. Nothing this loop dispatches can change the tree.
const READ_ONLY_PERMISSIONS = new Set<ToolPermission>([
  'read', 'search', 'fetch', 'git-read', 'browser', 'desktop',
]);

const NATIVE_GROUP_TASKS = [
  {
    group: 'computer_use',
    tool: 'desktop_windows',
    prompt: 'List the titles of the open desktop windows. Do not click or type.',
  },
  {
    group: 'media',
    tool: 'view_image',
    prompt: 'Inspect test/fixtures/vision-forge-7.png and describe its main visual elements.',
  },
  {
    group: 'editor_ui',
    tool: 'get_editor_context',
    prompt: 'Tell me the filename and selected text in the editor that is open right now.',
  },
  {
    group: 'system',
    tool: 'get_power_info',
    prompt: 'Report the computer power and wake-on-LAN information without changing anything.',
  },
  {
    group: 'memory',
    tool: 'list_memories',
    prompt: 'List the saved Forge memories so I can review them.',
  },
  {
    group: 'notebook',
    tool: 'read_notebook',
    prompt: 'Read test/fixtures/lazy-tool-groups.ipynb and report its markdown cell.',
  },
] as const;

const NON_GROUP_TASKS = [
  'What is 2 + 2? Answer with the number only.',
  'In one sentence, explain what an npm script is.',
];

const silentLog = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

let registry: ToolRegistry;
let mcp: { dispose(): void } | undefined;
let wrongGroupLoads = 0;

function countWrongGroupLoads(
  result: Awaited<ReturnType<typeof runLiveToolLoop>>,
  expectedGroup?: string,
): void {
  const loads = result.toolCalls.filter((call) => call.name === 'load_tool_group');
  wrongGroupLoads += loads.filter((call) => call.args['group'] !== expectedGroup).length;
}

async function buildRegistry(): Promise<void> {
  resetLazyToolGroups();
  registry = new ToolRegistry();
  registerAllTools(
    registry,
    { get: () => undefined, update: async () => undefined } as unknown as vscode.Memento,
    { get: async () => undefined } as unknown as vscode.SecretStorage,
    undefined,
    { search: async () => [] } as unknown as IndexManager,
    new UserQuestionService(),
    new UserNotificationService(),
    undefined,
    () => ({
      permissions: { browser: { enabled: true }, desktop: { enabled: true } },
    }) as ForgeConfig,
  );
  const config = loadConfig(path.join(ROOT, '.forge'));
  mcp = await connectMcpServers(config.mcp_servers ?? [], registry, silentLog);
}

/** The model-facing list for one conversation, composed as ModelTurn composes it. */
function definitionsFor(conversationId: string): () => ToolDefinition[] {
  return () => {
    const hidden = hiddenLazyToolNames(conversationId);
    return registry.definitions(READ_ONLY_PERMISSIONS).filter((d) => !hidden.has(d.function.name));
  };
}

describe.runIf(LIVE)('lazy tool groups against a live Qwen3.8', () => {
  beforeAll(async () => {
    if (MODEL.includes('no-vision')) {
      throw new Error('Set FORGE_LIVE_MODEL to a vision-capable model for the computer_use acceptance cases.');
    }
    await buildRegistry();
    // A green run here without all seven groups registered would prove nothing.
    for (const group of [
      'computer_use', 'media', 'editor_ui', 'system', 'memory', 'notebook', 'halluscribe',
    ]) expect(isLazyGroupAvailable(group)).toBe(true);
    const names = registry.definitions(READ_ONLY_PERMISSIONS).map((d) => d.function.name);
    expect(names).toContain('load_tool_group');
    const loader = registry.definitions(READ_ONLY_PERMISSIONS).find((d) => d.function.name === 'load_tool_group');
    expect(loader?.function.parameters).toMatchObject({
      properties: {
        group: {
          enum: ['computer_use', 'editor_ui', 'halluscribe', 'media', 'memory', 'notebook', 'system'],
        },
      },
    });
  }, 120_000);

  afterAll(() => {
    mcp?.dispose();
    expect(wrongGroupLoads).toBeLessThanOrEqual(1);
  });

  it('discovers and loads halluscribe from a historical-context question', async () => {
    const conversationId = 'live-history';
    const rounds: Array<{ call: string; nextDefinitions: string[] }> = [];

    const result = await runLiveToolLoop({
      endpoint: ENDPOINT,
      model: MODEL,
      prompt: 'What did we decide about the Forge prompt cache in our previous sessions?',
      registry,
      allowed: READ_ONLY_PERMISSIONS,
      context: { beforeMutate: () => undefined, conversationId },
      getDefinitions: definitionsFor(conversationId),
      maxSteps: 10,
      onRound: ({ call, nextDefinitions }) => rounds.push({ call, nextDefinitions }),
    });

    // eslint-disable-next-line no-console
    console.log('[history] calls:', result.calls.join(' -> '));

    countWrongGroupLoads(result, 'halluscribe');
    expect(result.calls[0]).toBe('load_tool_group');
    // The activation round must hand the NEXT request the six real schemas.
    expect(rounds[0]?.nextDefinitions).toEqual(expect.arrayContaining(HALLUSCRIBE_TOOLS));
    // ...and the model must then actually use one of them.
    expect(result.calls.slice(1).some((c) => HALLUSCRIBE_TOOLS.includes(c))).toBe(true);
  }, 300_000);

  it('recovers an exact past string through the loaded group', async () => {
    const conversationId = 'live-exact-string';
    const result = await runLiveToolLoop({
      endpoint: ENDPOINT,
      model: MODEL,
      prompt: 'Find the exact error we encountered previously with llama-tokenize.',
      registry,
      allowed: READ_ONLY_PERMISSIONS,
      context: { beforeMutate: () => undefined, conversationId },
      getDefinitions: definitionsFor(conversationId),
      maxSteps: 10,
    });

    // eslint-disable-next-line no-console
    console.log('[exact-string] calls:', result.calls.join(' -> '));

    countWrongGroupLoads(result, 'halluscribe');
    expect(result.calls).toContain('load_tool_group');
    expect(result.calls.some((c) => HALLUSCRIBE_TOOLS.includes(c))).toBe(true);
  }, 300_000);

  it('leaves the group unloaded on an ordinary coding request', async () => {
    const conversationId = 'live-ordinary';
    const result = await runLiveToolLoop({
      endpoint: ENDPOINT,
      model: MODEL,
      prompt: 'Read package.json in this workspace and tell me which script npm run ci runs.',
      registry,
      allowed: READ_ONLY_PERMISSIONS,
      context: { beforeMutate: () => undefined, conversationId },
      getDefinitions: definitionsFor(conversationId),
      maxSteps: 10,
    });

    // eslint-disable-next-line no-console
    console.log('[ordinary] calls:', result.calls.join(' -> '));

    countWrongGroupLoads(result);
    expect(result.calls).not.toContain('load_tool_group');
    expect(definitionsFor(conversationId)().map((d) => d.function.name)).not.toContain(
      'search_sessions',
    );
  }, 300_000);

  it.each(NON_GROUP_TASKS)('does not load a group for a non-needing task: %s', async (prompt) => {
    const conversationId = `live-non-group-${prompt.length}`;
    const result = await runLiveToolLoop({
      endpoint: ENDPOINT,
      model: MODEL,
      prompt,
      registry,
      allowed: READ_ONLY_PERMISSIONS,
      context: { beforeMutate: () => undefined, conversationId },
      getDefinitions: definitionsFor(conversationId),
      maxSteps: 6,
    });
    countWrongGroupLoads(result);
    expect(result.calls).not.toContain('load_tool_group');
  }, 300_000);

  it.each(NATIVE_GROUP_TASKS.flatMap((task) => [
    { ...task, kind: 'needs' as const },
    ...NON_GROUP_TASKS.map((prompt) => ({ ...task, kind: 'does not need' as const, prompt })),
  ]))('$kind $group for: $prompt', async ({ group, kind, prompt, tool }) => {
    const conversationId = `live-${group}-${kind}-${prompt.length}`;
    const result = await runLiveToolLoop({
      endpoint: ENDPOINT,
      model: MODEL,
      prompt,
      registry,
      allowed: READ_ONLY_PERMISSIONS,
      context: { beforeMutate: () => undefined, conversationId },
      getDefinitions: definitionsFor(conversationId),
      maxSteps: 8,
    });
    countWrongGroupLoads(result, kind === 'needs' ? group : undefined);
    if (kind === 'needs') {
      expect(result.calls[0]).toBe('load_tool_group');
      expect(result.calls).toContain(tool);
      expect(result.toolCalls.find((call) => call.name === 'load_tool_group')?.args['group']).toBe(group);
    } else {
      expect(result.calls).not.toContain('load_tool_group');
    }
  }, 300_000);
});
