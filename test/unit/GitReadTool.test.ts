import { describe, expect, it } from 'vitest';
import { makeGitReadTool } from '../../src/tools/gitReadTool';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import {
  hiddenLazyToolNames,
  lazyGroupForTool,
  resetLazyToolGroups,
} from '../../src/tools/lazyToolGroups';
import {
  makeGitBlameTool,
  makeGitDiffTool,
  makeGitLogTool,
  makeGitShowTool,
  makeGitStatusTool,
} from '../../src/tools/gitReadTools';

const operations = ['status', 'log', 'diff', 'blame', 'show'] as const;

describe('git_read', () => {
  it('advertises one strict operation-enum schema', () => {
    const schema = makeGitReadTool().definition.function.parameters;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['operation']);
    expect(schema.properties['operation'].enum).toEqual(operations);
  });

  it('retains each replaced git description verbatim', () => {
    const merged = makeGitReadTool().definition.function.description;
    for (const tool of [
      makeGitStatusTool(),
      makeGitLogTool(),
      makeGitDiffTool(),
      makeGitBlameTool(),
      makeGitShowTool(),
    ]) {
      expect(merged).toContain(tool.definition.function.description);
    }
  });

  it('keeps the git-read permission every replaced operation had (no approval)', () => {
    const tool = makeGitReadTool();
    expect(tool.permission).toBe('git-read');
    // ToolDispatch asks only for write/delete/terminal/headless/git-write permissions.
    // Every replaced read operation had git-read and therefore needed no approval.
    expect(['write', 'delete', 'terminal', 'headless', 'git-write']).not.toContain(tool.permission);
  });

  it('names the operation and missing path for blame', async () => {
    await expect(makeGitReadTool().handler({ operation: 'blame' })).rejects.toThrow(
      'git_read operation "blame" needs path',
    );
  });

  it('names the operation and missing ref for show', async () => {
    await expect(makeGitReadTool().handler({ operation: 'show' })).rejects.toThrow(
      'git_read operation "show" needs ref',
    );
  });

  // 6 calls against 418 shell git commands across the 53 sessions since 0.17.80
  // (docs/reports/TOOL_AUDIT_2026_10_29.md §5): the schema is not what the model
  // reaches for when it wants git, so it now costs nothing until the group loads.
  it('is a member of the lazy git group, so its schema is not advertised by default', () => {
    resetLazyToolGroups();
    const registry = new ToolRegistry();
    registry.register(makeGitReadTool());
    expect(lazyGroupForTool('git_read')).toBe('git');
    expect(hiddenLazyToolNames('git-audit-conversation')).toContain('git_read');
    resetLazyToolGroups();
  });
});
