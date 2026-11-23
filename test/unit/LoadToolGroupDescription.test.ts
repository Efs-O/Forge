import { beforeEach, describe, expect, it } from 'vitest';
import {
  isLazyGroupActive,
  recordLazyGroupTool,
  recordNativeLazyTool,
  resetLazyToolGroups,
} from '../../src/tools/lazyToolGroups';
import { mcpToolToRegisteredTool } from '../../src/tools/mcpBridge';
import { forgeMcpToolName } from '../../src/tools/mcpProviderContract';
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
          forgeMcpToolName(name),
          { name, inputSchema: { type: 'object' } },
          async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        ),
      );
      recordLazyGroupTool('sample_mcp', name);
    }

    expect(registry.get('load_tool_group')?.describe?.().function.description).toBe(
      'Load a tool group; the result says how to call its tools. Available groups:\n' +
        'code_intel: rename symbols, apply code actions, format files, semantic search (apply_code_action, format_file)\n' +
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

describe('load_tool_group load reply', () => {
  beforeEach(() => resetLazyToolGroups());

  // Build a registry the way registerAllTools does: the members are real
  // registered tools, and `isAdvertised` is the same lambda it passes, so the
  // reply reflects each tool's own `advertise` predicate.
  function mediaRig(members: { name: string; advertise?: () => boolean }[]) {
    const registry = new ToolRegistry();
    for (const { name, advertise } of members) {
      registry.register({
        definition: {
          type: 'function',
          function: { name, description: '', parameters: { type: 'object' } },
        },
        permission: 'read',
        ...(advertise ? { advertise } : {}),
        handler: async () => 'ok',
      });
      recordNativeLazyTool(name);
    }
    const isAdvertised = (name: string) => {
      const tool = registry.get(name);
      return tool !== undefined && (tool.advertise === undefined || tool.advertise());
    };
    registry.register(makeLoadToolGroupTool(isAdvertised));
    return registry;
  }

  const CTX = { beforeMutate: () => undefined, conversationId: 'conv-load' };

  it('keeps the old reply byte-for-byte when every member is advertised', async () => {
    const registry = mediaRig([{ name: 'view_image' }, { name: 'image_search' }]);
    const result = await registry.dispatch(
      'load_tool_group',
      { group: 'media' },
      ALL_PERMISSIONS,
      CTX,
    );
    expect(result).toBe(
      'media tools enabled for this conversation: image_search, view_image. ' +
        'They are listed on the next step.',
    );
  });

  it('names members that are not set up in this window separately', async () => {
    const registry = mediaRig([
      { name: 'view_image' },
      { name: 'image_search', advertise: () => false },
    ]);
    const result = await registry.dispatch(
      'load_tool_group',
      { group: 'media' },
      ALL_PERMISSIONS,
      CTX,
    );
    expect(result).toBe(
      'media tools enabled for this conversation: view_image. They are listed on the next step. ' +
        'Not set up in this window, so not listed: image_search.',
    );
  });

  it('refuses and activates nothing when no member is advertised', async () => {
    const registry = mediaRig([{ name: 'image_search', advertise: () => false }]);
    const error = await registry
      .dispatch('load_tool_group', { group: 'media' }, ALL_PERMISSIONS, CTX)
      .then(() => undefined)
      .catch((e: unknown) => e as Error);
    expect(error?.message).toBe(
      'load_tool_group: group "media" is unavailable because none of its tools is set up in ' +
        'this window; do not retry. Answer from the workspace and the conversation instead.',
    );
    expect(isLazyGroupActive('conv-load', 'media')).toBe(false);
  });
});
