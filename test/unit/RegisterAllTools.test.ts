import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import type { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { IndexManager } from '../../src/search/IndexManager';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { registerAllTools } from '../../src/tools/registerAllTools';
import { ToolRegistry, type ToolPermission } from '../../src/tools/ToolRegistry';

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

const EXPECTED_NATIVE_NAMES = [
  'append_file',
  'apply_code_action',
  'apply_line_edits',
  'ask_live_session',
  'ask_local_agent',
  'ask_user',
  'commit',
  'copy_to_clipboard',
  'create_branch',
  'create_directory',
  'delete_file',
  'edit_file',
  'edit_notebook_cell',
  'exec_command',
  'find_files',
  'find_implementations',
  'find_references',
  'format_file',
  'generate_image',
  'get_code_actions',
  'get_diagnostics',
  'get_document_symbols',
  'get_editor_context',
  'get_hover',
  'get_power_info',
  'get_system_status',
  'get_workspace_symbols',
  'git_blame',
  'git_diff',
  'git_log',
  'git_show',
  'git_status',
  'go_to_definition',
  'image_search',
  'insert_code',
  'install_llamacpp',
  'list_delegation_targets',
  'list_directory',
  'list_executions',
  'list_memories',
  'list_workspace_tasks',
  'load_tool_group',
  'monitor_execution',
  'move_file',
  'notify_user',
  'open_file',
  'open_url_in_browser',
  'query_powershell',
  'read_clipboard',
  'read_file',
  'read_notebook',
  'read_tool_result',
  'recall',
  'remember',
  'rename_symbol',
  'replace_selection',
  'restore_file',
  'run_build',
  'run_terminal',
  'run_tests',
  'run_workspace_task',
  'schedule_wake',
  'search_code',
  'search_codebase',
  'show_diff',
  'show_notification',
  'sleep_computer',
  'stage',
  'stop_execution',
  'switch_branch',
  'tell_live_session',
  'update_plan',
  'view_image',
  'view_video',
  'wait',
  'web_fetch',
  'web_search',
  'write_file',
];

function makeRegistry(
  options: { search?: boolean; delegation?: boolean; images?: boolean } = {},
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
    ...(options.images
      ? {
          image_generation: {
            output_dir: 'generated-images',
            backends: [
              { name: 'grok', provider: 'xai' as const, model: 'img', confirm_each: true },
            ],
          },
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
  it('exposes the exact 78-tool native catalog when all optional wiring is present', () => {
    const registry = makeRegistry({ search: true, delegation: true });
    expect(registry.names().sort()).toEqual(EXPECTED_NATIVE_NAMES);
    // load_tool_group is registered but suppresses its own advertisement while
    // no lazy MCP group has been bridged in, and generate_image while config.yaml
    // has no image_generation block, install_llamacpp while it sets no
    // llama_server.binary, and ask_live_session while it has no
    // enabled agent_bus block, so the tools the model actually sees are
    // unchanged for a config that uses neither.
    expect(
      registry
        .definitions(ALL_PERMISSIONS)
        .map((tool) => tool.function.name)
        .sort(),
    ).toEqual(
      EXPECTED_NATIVE_NAMES.filter(
        (name) =>
          name !== 'load_tool_group' &&
          name !== 'generate_image' &&
          name !== 'image_search' &&
          name !== 'install_llamacpp' &&
          name !== 'ask_live_session' &&
          name !== 'tell_live_session',
      ),
    );
  });

  it('advertises generate_image once image_generation is configured', () => {
    const registry = makeRegistry({ delegation: true, images: true });
    const names = registry.definitions(ALL_PERMISSIONS).map((tool) => tool.function.name);
    expect(names).toContain('generate_image');
  });

  it('lets search and delegation wiring control only their documented tools', () => {
    const names = makeRegistry().names();
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('ask_local_agent');
    expect(names).not.toContain('list_delegation_targets');
    expect(names).toHaveLength(70);
  });
});
