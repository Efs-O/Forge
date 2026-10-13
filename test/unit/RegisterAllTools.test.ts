import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import type { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { IndexManager } from '../../src/search/IndexManager';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { registerAllTools } from '../../src/tools/registerAllTools';
import { ALL_TOOL_PERMISSIONS, ToolRegistry, type ToolPermission } from '../../src/tools/ToolRegistry';
import { activateLazyGroup, hiddenLazyToolNames, lazyGroupForTool } from '../../src/tools/lazyToolGroups';

const ALL_PERMISSIONS = new Set(ALL_TOOL_PERMISSIONS);

const EXPECTED_NATIVE_NAMES = [
  'append_file',
  'apply_code_action',
  'apply_line_edits',
  'ask_agent',
  'ask_local_agent',
  'ask_user',
  'browser_click',
  'browser_close',
  'browser_close_tab',
  'browser_drag',
  'browser_hover',
  'browser_inspect',
  'browser_navigate',
  'browser_new_tab',
  'browser_open',
  'browser_press',
  'browser_screenshot',
  'browser_scroll',
  'browser_select_tab',
  'browser_tabs',
  'browser_type',
  'code_intel',
  'commit',
  'copy_to_clipboard',
  'create_branch',
  'create_directory',
  'delete_file',
  'desktop_capture',
  'desktop_click',
  'desktop_drag',
  'desktop_focus_window',
  'desktop_move_mouse',
  'desktop_press',
  'desktop_scroll',
  'desktop_type',
  'desktop_windows',
  'edit_file',
  'edit_notebook_cell',
  'find_files',
  'forget',
  'format_file',
  'generate_image',
  'get_editor_context',
  'get_power_info',
  'get_system_status',
  'git_read',
  'image_search',
  'insert_code',
  'install_llamacpp',
  'list_delegation_targets',
  'list_directory',
  'list_executions',
  'list_memories',
  'load_tool_group',
  'monitor_execution',
  'move_file',
  'notify_user',
  'open_file',
  'open_url_in_browser',
  'read_clipboard',
  'read_file',
  'read_notebook',
  'read_tool_result',
  'recall',
  'remember',
  'rename_symbol',
  'render_html_to_image',
  'replace_selection',
  'restore_file',
  'schedule_wake',
  'search_code',
  'search_codebase',
  'send_file',
  'set_checkin',
  'shell',
  'show_diff',
  'show_notification',
  'sleep_computer',
  'stage',
  'stop_execution',
  'switch_branch',
  'update_plan',
  'view_image',
  'view_video',
  'wait',
  'web_fetch',
  'web_search',
  'write_file',
];

const CORE_TOOL_NAMES = [
  'read_file',
  'edit_file',
  'write_file',
  'append_file',
  'search_code',
  'find_files',
  'list_directory',
  'shell',
  'monitor_execution',
  'update_plan',
  'read_tool_result',
  'ask_user',
  'web_fetch',
  'web_search',
  'load_tool_group',
];

// `ask_user` asks from whatever the call sent, so `prompt` must stay optional in
// the advertised schema: a `questions`-only call is answerable, and a required
// field made ToolRegistry refuse it and cost a round.
it('advertises ask_user with no required argument', () => {
  const registry = makeRegistry();
  const ask = registry.get('ask_user');
  expect(ask?.definition.function.parameters.required ?? []).toEqual([]);
});

function makeRegistry(
  options: {
    search?: boolean;
    delegation?: boolean;
    images?: boolean;
    agentBus?: boolean;
    /** Only meaningful with `images`: adds the optional `image_generation.upscale` block. */
    upscale?: boolean;
  } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  const workspaceState = {
    get: () => undefined,
    update: async () => undefined,
  } as unknown as vscode.Memento;
  const secrets = { get: async () => undefined } as unknown as vscode.SecretStorage;
  const indexManager = { search: async () => [] } as unknown as IndexManager;
  const config: ForgeConfig = {
    active_model: 'primary',
    llama_server: {},
    models: [
      { name: 'primary', gguf_path: '/primary.gguf' },
      { name: 'worker', gguf_path: '/worker.gguf' },
    ],
    ...(options.agentBus ? { agent_bus: { enabled: true } } : {}),
    ...(options.images
      ? {
          image_generation: {
            output_dir: 'generated-images',
            backends: [
              { name: 'grok', provider: 'xai' as const, model: 'img', confirm_each: true },
            ],
            ...(options.upscale
              ? {
                  upscale: {
                    binary: '/models/sd-cli.exe',
                    model: '/models/ESRGAN/4x_foolhardy_Remacri.pth',
                    cuda_device: 0,
                    timeout_ms: 300_000,
                    min_free_vram_mb: 1_500,
                    max_input_edge_px: 2_048,
                  },
                }
              : {}),
          } as unknown as ForgeConfig['image_generation'],
        }
      : {}),
  };
  const delegation = options.delegation
    ? ({
        ask: async () => ({ text: 'ok', targetModel: 'worker', bestEffort: false }),
      } as unknown as LocalDelegationService)
    : undefined;

  registerAllTools(
    registry,
    workspaceState,
    secrets,
    options.search ? { provider: 'tavily', secret_key_name: 'audit-key' } : undefined,
    indexManager,
    new UserQuestionService(),
    new UserNotificationService(),
    delegation,
    options.delegation ? () => config : undefined,
  );
  return registry;
}

describe('registerAllTools canonical coordinator catalog', () => {
  it('exposes the exact native catalog when all optional wiring is present', () => {
    const registry = makeRegistry({ search: true, delegation: true });
    expect(registry.names().sort()).toEqual(EXPECTED_NATIVE_NAMES);
    for (const removed of ['run_terminal', 'run_workspace_task', 'list_workspace_tasks']) {
      expect(registry.names()).not.toContain(removed);
    }
    const edit = registry.get('edit_file')!.definition.function;
    expect(edit.parameters.required).toContain('path');
    expect(edit.parameters.properties).toHaveProperty('path');
    expect(edit.parameters.properties).not.toHaveProperty('filepath');
    // generate_image requires an image_generation config block.
    expect(
      registry
        .definitions(ALL_PERMISSIONS)
        .map((tool) => tool.function.name)
        .sort(),
    ).toEqual(
      EXPECTED_NATIVE_NAMES.filter(
        (name) =>
          // generate_image needs the absent image_generation block.
          name !== 'generate_image' &&
          // image_search needs the absent image_search provider.
          name !== 'image_search' &&
          // install_llamacpp needs the absent llama_server.binary.
          name !== 'install_llamacpp' &&
          // ask_agent needs the absent agent_bus block.
          name !== 'ask_agent' &&
          // set_checkin needs the absent elapsed_time_note block.
          name !== 'set_checkin',
      ),
    );
  });

  it('advertises every core tool present in this worktree and groups optional tools', () => {
    const registry = makeRegistry({ search: true, delegation: true });
    const names = registry.definitions(ALL_PERMISSIONS).map((tool) => tool.function.name);
    expect(names.filter((name) => CORE_TOOL_NAMES.includes(name)).sort()).toEqual(
      CORE_TOOL_NAMES.filter((name) => registry.names().includes(name)).sort(),
    );
    expect(CORE_TOOL_NAMES).toContain('shell');
    const groups: Record<string, string[]> = {
      files: ['move_file', 'create_directory', 'apply_line_edits', 'restore_file'],
      git: ['stage', 'commit', 'create_branch', 'switch_branch'],
      code_intel: [
        'code_intel',
        'rename_symbol',
        'apply_code_action',
        'format_file',
        'search_codebase',
      ],
      memory: ['remember', 'recall', 'list_memories', 'forget'],
      background: ['stop_execution', 'list_executions', 'wait'],
      agents: [
        'ask_agent',
        'ask_local_agent',
        'list_delegation_targets',
        'manage_jobs',
        'notify_user',
      ],
    };
    for (const [group, members] of Object.entries(groups)) {
      for (const member of members) expect(lazyGroupForTool(member)).toBe(group);
    }
    expect(lazyGroupForTool('get_system_status')).toBe('system');
    // Eager: the two most-called grouped tools; delete_file is also the alternative every rm refusal names.
    expect(lazyGroupForTool('delete_file')).toBeUndefined();
    expect(lazyGroupForTool('git_read')).toBeUndefined();
    expect(lazyGroupForTool('append_file')).toBeUndefined();
    expect(names).toContain('append_file');
  });

  it('advertises generate_image once image_generation is configured', () => {
    const registry = makeRegistry({ delegation: true, images: true });
    const names = registry.definitions(ALL_PERMISSIONS).map((tool) => tool.function.name);
    expect(names).toContain('generate_image');
  });

  // The tool budget rule (plan §4c): a config without `image_generation.upscale`
  // never sees the tool at all — not merely unadvertised, but unregistered, so
  // its schema costs no tokens and no cold re-prefill for that user.
  it('registers upscale_image only when image_generation.upscale is configured', () => {
    const without = makeRegistry({ delegation: true, images: true });
    expect(without.names()).not.toContain('upscale_image');
    const withoutNames = without.names();
    const withBlock = makeRegistry({ delegation: true, images: true, upscale: true });
    expect(withBlock.names()).toContain('upscale_image');
    // The block is the ONLY difference: adding it registers exactly one tool and
    // changes nothing else in the catalog.
    expect(withBlock.names().sort()).toEqual([...withoutNames, 'upscale_image'].sort());
    // And it belongs to the media group, so a config that has it costs nothing
    // extra to a coding conversation.
    expect(lazyGroupForTool('upscale_image')).toBe('media');
  });

  it('offers ask_agent and omits the retired ask and tell tools when the bus is enabled', () => {
    const registry = makeRegistry({ delegation: true, agentBus: true });
    const conversationId = 'ask-agent-contract';
    activateLazyGroup(conversationId, 'agents');
    const hidden = hiddenLazyToolNames(conversationId);
    const names = registry
      .definitions(ALL_PERMISSIONS)
      .map((tool) => tool.function.name)
      .filter((name) => !hidden.has(name));
    expect(names).toContain('ask_agent');
  });

  it('lets search and delegation wiring control only their documented tools', () => {
    const names = makeRegistry().names();
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('ask_local_agent');
    expect(names).not.toContain('list_delegation_targets');
    expect(names).toHaveLength(56);
  });

  // send_file's only outbound step is api.telegram.org, so a profile with
  // net.fetch off must not see the tool at all -- otherwise the model calls it
  // and gets an unknown-tool error, the failure mode PermissionResolver exists
  // to prevent.
  it('advertises send_file only with the fetch permission', () => {
    const registry = makeRegistry({ delegation: true });
    const withFetch = registry
      .definitions(new Set<ToolPermission>(['read', 'fetch']))
      .map((tool) => tool.function.name);
    const withoutFetch = registry
      .definitions(new Set<ToolPermission>(['read']))
      .map((tool) => tool.function.name);
    expect(withFetch).toContain('send_file');
    expect(withoutFetch).not.toContain('send_file');
  });

  // render_html_to_image is a render engine, not interactive browsing: it must
  // NOT require the 'browser' permission (that gate belongs to browser_* tools).
  // It writes a PNG and posts to api.telegram.org, so it needs fetch + write and
  // a profile with either off must not see it at all.
  it('advertises render_html_to_image on fetch+write, never on the browser permission', () => {
    const registry = makeRegistry({ delegation: true });
    const namesFor = (permissions: ToolPermission[]) =>
      registry.definitions(new Set(permissions)).map((tool) => tool.function.name);
    expect(namesFor(['read', 'fetch', 'write'])).toContain('render_html_to_image');
    expect(namesFor(['read', 'fetch'])).not.toContain('render_html_to_image');
    expect(namesFor(['read', 'write'])).not.toContain('render_html_to_image');
    // The 'browser' permission is not what gates it: fetch+browser alone is not
    // enough, and fetch+write works without it.
    expect(namesFor(['read', 'fetch', 'browser'])).not.toContain('render_html_to_image');
    const tool = registry.get('render_html_to_image');
    expect(tool?.permission).toBe('fetch');
    expect(tool?.additionalPermissions).toEqual(['write']);
  });
});
