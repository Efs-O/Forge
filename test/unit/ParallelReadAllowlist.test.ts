import { describe, expect, it } from 'vitest';
import {
  isParallelReadOnlyTool,
  parallelReadOnlyToolNames,
} from '../../src/sidebar/ToolDispatchParallel';
import { makeMaximalRegistry } from '../support/maximalToolRegistry';

describe('parallel read allowlist', () => {
  it('pins registered tools whose metadata passes every read-only flag', () => {
    const names = parallelReadOnlyToolNames();
    expect(names).toEqual([
      'code_intel',
      'find_files',
      'get_editor_context',
      'git_read',
      'grep_search',
      'list_directory',
      'list_memories',
      'read_file',
      'read_notebook',
      'recall',
    ]);

    const registry = makeMaximalRegistry();
    for (const name of names) {
      const tool = registry.get(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      if (!tool) continue;
      expect(['read', 'git-read']).toContain(tool.permission);
      expect(tool.mutation).toBeUndefined();
      expect(tool.workspaceStateMutation).not.toBe(true);
      expect(tool.untrustedResult).not.toBe(true);
      expect(tool.reachesOut).toBeUndefined();
      expect(tool.refuseBeforeApproval).toBeUndefined();
    }
  });

  it.each([
    'write_file',
    'web_fetch',
    'web_search',
    'shell',
    'browser_screenshot',
    'forget',
    'remember',
    'search_codebase',
    'read_tool_result',
  ])('keeps %s serial', (name) => {
    expect(isParallelReadOnlyTool(name)).toBe(false);
  });
});
