import type * as vscode from 'vscode';
import type { ForgeConfig } from '../src/config/types';
import type { LocalDelegationService } from '../src/delegation/LocalDelegationService';
import type { IndexManager } from '../src/search/IndexManager';
import type { JobStore } from '../src/jobs/JobStore';
import { UserNotificationService } from '../src/sidebar/UserNotificationService';
import { UserQuestionService } from '../src/sidebar/UserQuestionService';
import { ALL_TOOL_PERMISSIONS, ToolRegistry } from '../src/tools/ToolRegistry';
import { registerAllTools } from '../src/tools/registerAllTools';
import { recordLazyGroupTool, resetLazyToolGroups } from '../src/tools/lazyToolGroups';

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
      // registered when it is configured, and the budget gate exists to price
      // the maximally-advertised set.
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
    // Same reason as the budget test: `set_checkin` exists only with its block,
    // and the coverage matrix must show it.
    elapsed_time_note: { after_minutes: 30 },
  };
}

/**
 * desktop_* and install_llamacpp advertise on Windows only. The catalog prices
 * the maximal set, and Windows advertises the most, so a Linux or macOS CI
 * runner must read it as Windows does or the committed coverage matrix drifts.
 */
function asWindows<T>(read: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    return read();
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
}

export function buildToolAuditSnapshot() {
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

  resetLazyToolGroups();
  recordLazyGroupTool('halluscribe', 'search_sessions');
  const definitions = asWindows(() => registry.definitions(new Set(ALL_TOOL_PERMISSIONS)));
  return {
    names: registry.names().sort(),
    registryDefinitions: definitions,
    definitions: definitions.map((definition) => {
      const tool = registry.get(definition.function.name);
      if (!tool) throw new Error(`Tool audit registry lost ${definition.function.name}`);
      return {
        type: definition.type,
        function: definition.function,
        source: 'src/tools/registerAllTools.ts',
        origin: 'native' as const,
        permission: tool.permission,
      };
    }),
    permissions: [...ALL_TOOL_PERMISSIONS],
  };
}
