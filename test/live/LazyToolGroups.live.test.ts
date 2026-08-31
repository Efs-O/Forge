// Live model test for demand-loaded MCP tool groups (src/tools/lazyToolGroups.ts).
//
// The unit tests prove the mechanism. The open question this answers is
// behavioural: from a ~125-token capability description alone, does Qwen3.8
// recognise a task that needs session history and load the group -- and does it
// leave the group alone on ordinary coding work?
//
// Requires llama-server serving the Qwen3.8 GGUF, and the real HalluScribe MCP
// server from .forge/config.yaml (its six schemas are used verbatim -- nothing
// here restates or shortens them).
//
//   FORGE_LIVE_LAZY_TOOLS=1 npx vitest run test/live/LazyToolGroups.live.test.ts
//
// Permissions are deliberately non-mutating: the loop dispatches for real, and
// a live model should not be able to write to this workspace to satisfy a test.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import type * as vscode from 'vscode';
import { loadConfig } from '../../src/config/ConfigLoader';
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
const READ_ONLY_PERMISSIONS = new Set<ToolPermission>(['read', 'search', 'fetch', 'git-read']);

const silentLog = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

let registry: ToolRegistry;
let mcp: { dispose(): void } | undefined;

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
    await buildRegistry();
    // A green run here with the MCP server down would prove nothing.
    expect(isLazyGroupAvailable('halluscribe')).toBe(true);
  }, 120_000);

  afterAll(() => mcp?.dispose());

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

    expect(result.calls).not.toContain('load_tool_group');
    expect(definitionsFor(conversationId)().map((d) => d.function.name)).not.toContain(
      'search_sessions',
    );
  }, 300_000);
});
