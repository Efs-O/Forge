import type * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import type { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { IndexManager } from '../../src/search/IndexManager';
import type { JobStore } from '../../src/jobs/JobStore';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { registerAllTools } from '../../src/tools/registerAllTools';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import {
  recordLazyGroupTool,
  recordNativeLazyTool,
  resetLazyToolGroups,
} from '../../src/tools/lazyToolGroups';

/**
 * Enables every optional tool block so the maximally-advertised set is
 * produced. `.forge/config.yaml` is gitignored and absent in CI, so this
 * synthetic config is the only way to reach the worst case deterministically.
 */
export function maximalConfig(): ForgeConfig {
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
    // `message_chat`'s gated actions are advertised text, so pricing the worst
    // case means pricing them: a window with `permissions.chats` on shows more
    // than one without, and the ceiling has to cover what a user can turn on.
    // `exec.shell` is pinned for the mirror reason: left unset, the shell tool
    // probes for Git for Windows, and a host without it prices the shorter
    // PowerShell-shaped description — which is how the same tree measured 67,511 on
    // the ubuntu and macOS runners and 68,029 here. The worst case is bash on
    // Windows, so that is what every runner has to measure.
    permissions: { chats: { new_chat: true, steer: true }, exec: { shell: 'bash' } },
    agent_links: { open_panel: 'every_ask', panel_live_timeout_ms: 20_000 },
    // `set_checkin` is registered only when this block exists, so pricing the
    // maximally-advertised set means pricing it with the block present.
    elapsed_time_note: { after_minutes: 30 },
  };
}

export function makeMaximalRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const workspaceState = {
    get: () => undefined,
    update: async () => undefined,
  } as unknown as vscode.Memento;
  const secrets = { get: async () => undefined } as unknown as vscode.SecretStorage;
  const indexManager = {
    search: async () => [],
    isEnabled: () => true,
  } as unknown as IndexManager;
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
    // The skills provider, so the maximally-advertised set prices `load_skill` in:
    // an unwired registry advertises it (nothing installed), which is exactly what
    // a config with skills enabled and no skill folders shows.
    {
      isEnabled: () => true,
      listCatalogEntries: () => [],
      loadSkillByName: async () => null,
    },
  );
  // load_tool_group advertises only once a lazy group is bridged in. Record one
  // so the maximally-advertised set includes it, matching a config that has
  // HalluScribe configured (the worst case for schema size).
  resetLazyToolGroups();
  recordLazyGroupTool('halluscribe', 'search_sessions');
  for (const name of registry.names()) recordNativeLazyTool(name);
  return registry;
}
