import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import type { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { IndexManager } from '../../src/search/IndexManager';
import type { JobStore } from '../../src/jobs/JobStore';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { registerAllTools } from '../../src/tools/registerAllTools';
import { ALL_TOOL_PERMISSIONS, ToolRegistry } from '../../src/tools/ToolRegistry';
import { lazyGroupForTool, lazyGroupNames, lazyGroupMembers } from '../../src/tools/lazyToolGroups';

const ALL_PERMISSIONS = new Set(ALL_TOOL_PERMISSIONS);

/**
 * Scratch measurement for the text-streamline plan (INSTRUCTION_AND_TOOL_TEXT_
 * STREAMLINE_PLAN.md phase 0): per-tool advertised characters, so a trim can be
 * attributed to the tool it came from instead of only to the total. Deleted
 * after the plan lands; the permanent gate is ToolSchemaBudget.test.ts.
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
      backends: [{ name: 'grok', provider: 'openai', model: 'img', confirm_each: true }],
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
    permissions: { chats: { new_chat: true, steer: true } },
    agent_links: { open_panel: 'every_ask', panel_live_timeout_ms: 20_000 },
    elapsed_time_note: { after_minutes: 30 },
  };
}

describe('phase 0 text surface dump', () => {
  it('prints per-tool advertised characters', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const registry = new ToolRegistry();
    const workspaceState = { get: () => undefined, update: async () => undefined } as unknown as vscode.Memento;
    const secrets = { get: async () => undefined } as unknown as vscode.SecretStorage;
    const indexManager = {
    search: async () => [],
    isEnabled: () => true,
  } as unknown as IndexManager;
    const config = maximalConfig();
    const delegation = {
      ask: async () => ({ text: 'ok', targetModel: 'worker', bestEffort: false }),
    } as unknown as LocalDelegationService;
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
      { store: { root: '/tmp/jobs' } as unknown as JobStore, hostFacade: () => undefined },
      { isEnabled: () => true, listCatalogEntries: () => [], loadSkillByName: async () => null },
    );

    const rows = registry
      .definitions(ALL_PERMISSIONS)
      .map((definition) => {
        const fn = definition.function;
        const schema = JSON.stringify(fn.parameters ?? {});
        return {
          name: fn.name,
          desc: (fn.description ?? '').length,
          schema: schema.length,
          total: JSON.stringify(definition).length,
          fields: Object.keys((fn.parameters as { properties?: Record<string, unknown> })?.properties ?? {})
            .length,
        };
      })
      .sort((a, b) => b.total - a.total);

    const sum = (key: 'desc' | 'schema' | 'total') =>
      rows.reduce((total, row) => total + row[key], 0);
    console.log(
      `SURFACE tools=${rows.length} desc=${sum('desc')} schema=${sum('schema')} total=${sum('total')}`,
    );
    for (const row of rows.slice(0, 22)) {
      console.log(
        `SURFACE_ROW ${row.name} total=${row.total} desc=${row.desc} schema=${row.schema} fields=${row.fields}`,
      );
    }

    // Eager versus lazy: a tool in a group costs context only once that group is
    // loaded, so the per-turn fixed cost is the eager half alone.
    let eager = 0;
    let lazy = 0;
    const byGroup = new Map<string, { tools: number; chars: number }>();
    for (const row of rows) {
      const group = lazyGroupForTool(row.name);
      if (group) {
        lazy += row.total;
        const seen = byGroup.get(group) ?? { tools: 0, chars: 0 };
        byGroup.set(group, { tools: seen.tools + 1, chars: seen.chars + row.total });
      } else {
        eager += row.total;
      }
    }
    console.log(`SURFACE_SPLIT eager_chars=${eager} lazy_chars=${lazy}`);
    for (const [group, seen] of [...byGroup.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
      console.log(
        `SURFACE_GROUP ${group} tools=${seen.tools} chars=${seen.chars} declared=${lazyGroupMembers(group).length}`,
      );
    }
    console.log(`SURFACE_GROUPS ${lazyGroupNames().join(',')}`);

    const shell = registry.definitions(ALL_PERMISSIONS).find((d) => d.function.name === 'shell');
    console.log(
      `SURFACE_SHELL chars=${(shell?.function.description ?? '').length} text=${JSON.stringify(
        shell?.function.description ?? '',
      )}`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
