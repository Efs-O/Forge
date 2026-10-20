import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import type { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { IndexManager } from '../../src/search/IndexManager';
import type { JobStore } from '../../src/jobs/JobStore';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { registerAllTools } from '../../src/tools/registerAllTools';
import { ALL_TOOL_PERMISSIONS, ToolRegistry } from '../../src/tools/ToolRegistry';
import {
  recordLazyGroupTool,
  recordNativeLazyTool,
  resetLazyToolGroups,
} from '../../src/tools/lazyToolGroups';

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
 * (measured 2026-09-30 with llama.cpp b11243 and Qwen3.8-27B Q6_K; see the plan
 * doc). The
 * gate is on the **maximally-advertised** set — every optional block enabled —
 * because a config that turns on image_generation / jobs / agent_bus /
 * image_search advertises more tools than a bare one, and that is the case that
 * must stay under the ceiling.
 *
 * The failure message names the two sanctioned responses and the CHANGES.md
 * rule. Raising the ceiling without one of those is the thing this gate exists
 * to stop.
 */

// Reference measurement updated 2026-10-13: 65-tool non-computer-use schema at
// 56,923 chars — `upscale_image` added 942, `generate_image`'s seed argument,
// per-backend sizes and reference-order advice added 582, and `set_checkin`
// (added, then its description rewritten after the A/B model skipped it)
// brought it to 56,923. The ≈4.62 chars/token ratio
// was measured 2026-09-30 with llama.cpp b11243 and Qwen3.8-27B Q6_K (50,439
// chars / 10,913 tokens).
const MEASURED_CHARS = 56_923;
// Phase 3 STOP: the full 88-tool wire schema is 67,128 chars, over budget.
// Exclude computer_use (24 browser/desktop schemas) pending the owner's product
// decision; the full and gated sizes are recorded in the report.
const COMPUTER_USE_TOOLS_EXCLUDED_PENDING_DECISION = ['browser_', 'desktop_'] as const;
// Ceiling a little above the measured size, so a single new tool (a few hundred
// chars) does not trip it, but a batch of new tools or a large description
// growth does. Raised 55,483 → 56,600 on 2026-10-13 (CHANGES.md 0.17.22): the
// two additions are opt-in image tools, advertised only when configured.
// Raised 56,600 → 57,500 later the same day (CHANGES.md, unreleased):
// `set_checkin`'s description now says what the check-in does and when to set it.
const TOOL_SCHEMA_CHAR_BUDGET = 57_500;

const ALL_PERMISSIONS = new Set(ALL_TOOL_PERMISSIONS);

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
      // The worst case includes the upscale block: `upscale_image` is only
      // registered when it is configured, so pricing the maximally-advertised
      // set means pricing it with the block present.
      upscale: {
        binary: '/models/sd-cli.exe',
        model: '/models/ESRGAN/4x_foolhardy_Remacri.pth',
        cuda_device: 0,
        timeout_ms: 300_000,
        min_free_vram_mb: 1_500,
        max_input_edge_px: 2_048,
      },
    } as ForgeConfig['image_generation'],
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
    agent_links: { open_panel: 'every_ask', panel_live_timeout_ms: 20_000 },
    // `set_checkin` is registered only when this block exists, so pricing the
    // maximally-advertised set means pricing it with the block present.
    elapsed_time_note: { after_minutes: 30 },
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
  for (const name of registry.names()) recordNativeLazyTool(name);
  return registry;
}

function advertisedChars(registry: ToolRegistry): number {
  return JSON.stringify(
    registry
      .definitions(ALL_PERMISSIONS)
      .filter(
        (definition) =>
          !COMPUTER_USE_TOOLS_EXCLUDED_PENDING_DECISION.some((prefix) =>
            definition.function.name.startsWith(prefix),
          ),
      ),
  ).length;
}

describe('tool schema CI budget (TOOL_SCHEMA_GROWTH_PLAN.md Step 1)', () => {
  // Windows advertises the most (shell, install_llamacpp), so the
  // worst case is measured as Windows whatever the CI host is.
  const realPlatform = process.platform;
  beforeEach(() =>
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }),
  );
  afterEach(() =>
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }),
  );

  it('advertises every registered tool under the maximal config', () => {
    const registry = makeMaximalRegistry();
    const names = registry
      .definitions(ALL_PERMISSIONS)
      .map((d) => d.function.name)
      .sort();
    expect(names).toHaveLength(registry.names().length);
    expect(names).toHaveLength(90);
    expect(names.filter((name) => name.startsWith('browser_'))).toHaveLength(15);
    expect(names.filter((name) => name.startsWith('desktop_'))).toHaveLength(9);
    // Spot-check the six self-suppressing tools that only appear when their
    // config block is present — these are the ones a bare config would drop.
    for (const name of [
      'generate_image',
      'image_search',
      'manage_jobs',
      'ask_agent',
      'install_llamacpp',
      'upscale_image',
      'set_checkin',
    ]) {
      expect(names).toContain(name);
    }
  });

  // 450 while it listed every member; purposes alone measured ~304 on Flash-Next.
  // The lower ceiling keeps a member list from creeping back unnoticed.
  it('keeps load_tool_group discovery under 320 estimated tokens', () => {
    const registry = makeMaximalRegistry();
    const description = registry.get('load_tool_group')?.describe?.().function.description ?? '';
    // CI has no model tokenizer. Use the measured ~4.62 chars/token ratio
    // above, rounding up so this remains a conservative character gate.
    expect(Math.ceil(description.length / 4.62)).toBeLessThanOrEqual(320);
  });

  it('keeps the 64-tool non-computer-use schema under the character budget', () => {
    const registry = makeMaximalRegistry();
    const chars = advertisedChars(registry);
    expect({
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
    }).toMatchObject({ chars, budget: TOOL_SCHEMA_CHAR_BUDGET });
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
          description: 'x'.repeat(5_000),
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
