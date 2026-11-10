import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordLazyGroupTool,
  recordNativeLazyTool,
  resetLazyToolGroups,
} from '../../src/tools/lazyToolGroups';
import { mcpToolToRegisteredTool } from '../../src/tools/mcpBridge';
import { makeLoadToolGroupTool } from '../../src/tools/toolGroupTools';
import { ToolRegistry, type ToolPermission } from '../../src/tools/ToolRegistry';

const ALL_PERMISSIONS = new Set<ToolPermission>(['read']);

describe('load_tool_group description', () => {
  beforeEach(() => resetLazyToolGroups());

  it('names the members of a native purpose group and keeps the MCP form', () => {
    const registry = new ToolRegistry();
    registry.register(makeLoadToolGroupTool());
    for (const name of ['format_file', 'apply_code_action']) {
      registry.register({
        definition: {
          type: 'function',
          function: { name, description: '', parameters: { type: 'object' } },
        },
        permission: 'read',
        handler: async () => 'ok',
      });
      recordNativeLazyTool(name);
    }
    for (const name of ['fetch_page', 'list_repos']) {
      registry.register(
        mcpToolToRegisteredTool(
          'sample-mcp',
          { name, inputSchema: { type: 'object' } },
          async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        ),
      );
      recordLazyGroupTool('sample_mcp', name);
    }

    expect(registry.get('load_tool_group')?.describe?.().function.description).toBe(
      'Load a tool group; its tools appear on the next step. Available groups:\n' +
        'code_intel: definitions, references, renames, semantic search (apply_code_action, format_file)\n' +
        'sample_mcp: fetch_page, list_repos',
    );
  });

  it('lists sorted members in every registered purpose group', async () => {
    const registry = new ToolRegistry();
    registry.register(makeLoadToolGroupTool());
    for (const name of ['restore_file', 'move_file']) {
      registry.register({
        definition: {
          type: 'function',
          function: { name, description: '', parameters: { type: 'object' } },
        },
        permission: 'read',
        handler: async () => 'ok',
      });
      recordNativeLazyTool(name);
    }
    const description = registry.get('load_tool_group')?.describe?.().function.description;
    expect(description).toContain(
      'files: move or rename a file, line-number edits, restore a file from a commit (move_file, restore_file)',
    );

    const result = await registry.dispatch('load_tool_group', { group: 'files' }, ALL_PERMISSIONS, {
      beforeMutate: () => undefined,
      conversationId: 'conv-a',
    });
    expect(result).toBe(
      'files tools enabled for this conversation: move_file, restore_file. ' +
        'They are listed on the next step.',
    );
  });

  it('includes names alongside purposes for multiple native groups', () => {
    const registry = new ToolRegistry();
    registry.register(makeLoadToolGroupTool());
    for (const name of ['move_file', 'commit', 'wait', 'recall', 'view_image', 'read_notebook']) {
      registry.register({
        definition: {
          type: 'function',
          function: { name, description: '', parameters: { type: 'object' } },
        },
        permission: 'read',
        handler: async () => 'ok',
      });
      recordNativeLazyTool(name);
    }
    const lines = (registry.get('load_tool_group')?.describe?.().function.description ?? '')
      .split('\n')
      .slice(1);
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(line).toMatch(/^[a-z_]+: [^;]+$/);
    expect(lines).toContain(
      'files: move or rename a file, line-number edits, restore a file from a commit (move_file)',
    );
    expect(lines).toContain('notebook: Jupyter notebook cells (read_notebook)');
  });
});
