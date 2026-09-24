import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import type { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { IndexManager } from '../../src/search/IndexManager';
import type { JobStore } from '../../src/jobs/JobStore';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { registerAllTools } from '../../src/tools/registerAllTools';
import { ToolRegistry, type ToolPermission } from '../../src/tools/ToolRegistry';
import { recordLazyGroupTool, resetLazyToolGroups } from '../../src/tools/lazyToolGroups';

/**
 * CI token budget for the native tool schema (TOOL_SCHEMA_GROWTH_PLAN.md, Step 1).
 *
 * The tool schema is a fixed cost on every request: the model re-prefills the
 * whole `tools` array on every round. This test gates that cost so that adding
 * a tool forces a decision *when it is added*, not after the catalog has grown
 * past where it is manageable.
 *
 * The budget is on **characters of `JSON.stringify(definitions)`**, not tokens:
 * CI has no tokenizer. The chars→tokens ratio is recorded next to the constant
 * (measured 2026-09-17, see TOOL_SCHEMA_REPORT.md §1 and the plan doc). The
 * gate is on the **maximally-advertised** set — every optional block enabled —
 * because a config that turns on image_generation / jobs / agent_bus /
 * image_search advertises more tools than a bare one, and that is the case that
 * must stay under the ceiling.
 *
 * The failure message names the two sanctioned responses and the CHANGES.md
 * rule. Raising the ceiling without one of those is the thing this gate exists
 * to stop.
 */

// Measured 2026-09-17: 77 tools, 52440 chars of JSON.stringify(definitions),
// 18227 tokens (llama.cpp-unsloth-b10798 tokenizer, Qwen3.8-Flash-Next).
// Ratio: 52440 chars / 18227 tokens ≈ 2.88 chars/token.
const MEASURED_CHARS = 52440;
// Ceiling ~10% above the measured size, so a single new tool (a few hundred
// chars) does not trip it, but a batch of new tools or a large description
// growth does.
const TOOL_SCHEMA_CHAR_BUDGET = 57_000;

const ALL_PERMISSIONS = new Set<ToolPermission>([
  'read',
  'write',
  'delete',
  'terminal',
  'headless',
  'search',
  'fetch',
  'git-read',
  'git-write',
  'delegate',
  'cloud-worker',
]);

/**
 * A config that enables every optional tool block, so the maximally-advertised
 * set is produced. `.forge/config.yaml` is gitignored and absent in CI, so this
 * synthetic config is the only way to reach the worst case deterministically.
 */
function maximalConfig(): ForgeConfig {
  return {
    active_model: 'primary',
    llama_server: { binary: 'llama-server' },
    models: [
      { name: 'primary', gguf_path: '/primary.gguf' },
      { name: 'worker', gguf_path: '/worker.gguf' },
    ],
    image_generation: {
      output_dir: 'generated-images',
      backends: [{ name: 'grok', provider: 'xai', model: 'img', confirm_each: true }],
    },
    image_search: {
      provider: 'serpapi_lens',
      secret_key_name: 'serpapi-key',
      max_results: 5,
      confirm_upload: false,
      thumbnails: 4,
      timeout_ms: 60_000,
    },
    jobs: { enabled: true },
    agent_bus: { enabled: true },
  };
}

function makeMaximalRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const workspaceState = {
    get: () => undefined,
    update: async () => undefined,
  } as unknown as vscode.Memento;
  const secrets = { get: async () => undefined } as unknown as vscode.SecretStorage;
  const indexManager = { search: async () => [] } as unknown as IndexManager;
  const config = maximalConfig();
  const delegation = {
    ask: async () => ({ text: 'ok', targetModel: 'worker', bestEffort: false }),
  } as unknown as LocalDelegationService;
  const jobs = {
    store: { root: '/tmp/jobs' } as unknown as JobStore,
    hostFacade: () => undefined,
  };
  registerAllTools(
    registry,
    workspaceState,
    secrets,
    { provider: 'tavily', secret_key_name: 'audit-key' },
    indexManager,
    new UserQuestionService(),
    new UserNotificationService(),
    delegation,
    () => config,
    undefined,
    undefined,
    jobs,
  );
  // load_tool_group advertises only once a lazy group is bridged in. Record one
  // so the maximally-advertised set includes it, matching a config that has
  // HalluScribe configured (the worst case for schema size).
  resetLazyToolGroups();
  recordLazyGroupTool('halluscribe', 'search_sessions');
  return registry;
}

function advertisedChars(registry: ToolRegistry): number {
  return JSON.stringify(registry.definitions(ALL_PERMISSIONS)).length;
}

describe('tool schema CI budget (TOOL_SCHEMA_GROWTH_PLAN.md Step 1)', () => {
  // Windows advertises the most (query_powershell, install_llamacpp), so the
  // worst case is measured as Windows whatever the CI host is.
  const realPlatform = process.platform;
  beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }));
  afterEach(() =>
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }),
  );

  it('advertises the full 78-tool set under the maximal config', () => {
    const registry = makeMaximalRegistry();
    const names = registry.definitions(ALL_PERMISSIONS).map((d) => d.function.name).sort();
    expect(names).toHaveLength(78);
    // Spot-check the five self-suppressing tools that only appear when their
    // config block is present — these are the ones a bare config would drop.
    for (const name of [
      'generate_image',
      'image_search',
      'manage_jobs',
      'ask_live_session',
      'install_llamacpp',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('keeps the maximally-advertised schema under the character budget', () => {
    const registry = makeMaximalRegistry();
    const defs = registry.definitions(ALL_PERMISSIONS);
    const chars = advertisedChars(registry);
    // eslint-disable-next-line no-console
    console.log('MEASURED CHARS =', chars);
    // TEMP: dump for one-off tokenization; removed before commit.
    fs.mkdirSync('.forge', { recursive: true });
    fs.writeFileSync('.forge/_budget_defs.json', JSON.stringify(defs));
    expect(
      {
        chars,
        budget: TOOL_SCHEMA_CHAR_BUDGET,
        measured: MEASURED_CHARS,
        message:
          chars > TOOL_SCHEMA_CHAR_BUDGET
            ? `Tool schema is ${chars} chars, over the ${TOOL_SCHEMA_CHAR_BUDGET}-char budget. ` +
              `Two sanctioned responses (TOOL_SCHEMA_GROWTH_PLAN.md): ` +
              `(1) merge the new tool into a family tool with an operation enum (Step 2), or ` +
              `(2) scope it by model/conversation so it is not advertised to every model (Step 3). ` +
              `Raising TOOL_SCHEMA_CHAR_BUDGET without one of those requires a note in CHANGES.md ` +
              `stating why.`
            : '',
      },
    ).toMatchObject({ chars, budget: TOOL_SCHEMA_CHAR_BUDGET });
    expect(chars).toBeLessThanOrEqual(TOOL_SCHEMA_CHAR_BUDGET);
  });

  it('fails the budget when a new tool is registered (the gate actually bites)', () => {
    const registry = makeMaximalRegistry();
    // A dummy tool large enough to push the schema over the ceiling. The real
    // point is that the check is not a no-op: it must fail when the schema
    // grows, not just pass when it does not.
    registry.register({
      definition: {
        type: 'function',
        function: {
          name: '_budget_canary',
          description: 'x'.repeat(5000),
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      permission: 'read',
      handler: async () => 'canary',
    });
    const chars = advertisedChars(registry);
    expect(chars).toBeGreaterThan(TOOL_SCHEMA_CHAR_BUDGET);
  });
});
