import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import type { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { IndexManager } from '../../src/search/IndexManager';
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
  'find_references',
  'format_file',
  'get_code_actions',
  'get_diagnostics',
  'get_document_symbols',
  'get_hover',
  'get_workspace_symbols',
  'git_blame',
  'git_diff',
  'git_log',
  'git_show',
  'git_status',
  'go_to_definition',
  'insert_code',
  'list_directory',
  'list_executions',
  'list_memories',
  'list_workspace_tasks',
  'monitor_execution',
  'move_file',
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
  'run_build',
  'run_terminal',
  'run_tests',
  'run_workspace_task',
  'search_code',
  'search_codebase',
  'show_diff',
  'show_notification',
  'stage',
  'stop_execution',
  'switch_branch',
  'update_plan',
  'view_image',
  'view_video',
  'web_fetch',
  'web_search',
  'write_file',
];

function makeRegistry(options: { search?: boolean; delegation?: boolean } = {}): ToolRegistry {
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
    delegation,
    options.delegation ? () => config : undefined,
  );
  return registry;
}

describe('registerAllTools canonical coordinator catalog', () => {
  it('exposes the exact 61-tool native catalog when all optional wiring is present', () => {
    const registry = makeRegistry({ search: true, delegation: true });
    expect(registry.names().sort()).toEqual(EXPECTED_NATIVE_NAMES);
    expect(
      registry
        .definitions(ALL_PERMISSIONS)
        .map((tool) => tool.function.name)
        .sort(),
    ).toEqual(EXPECTED_NATIVE_NAMES);
  });

  it('lets search and delegation wiring control only their documented tools', () => {
    const names = makeRegistry().names();
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('ask_local_agent');
    expect(names).toHaveLength(59);
  });
});
