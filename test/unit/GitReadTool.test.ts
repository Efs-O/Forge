import { describe, expect, it } from 'vitest';
import { makeGitReadTool } from '../../src/tools/gitReadTool';
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

  it.each(operations)('%s retains the old git-read auto-approval behavior', (operation) => {
    const tool = makeGitReadTool();
    expect(tool.permission).toBe('git-read');
    // ToolDispatch asks only for write/delete/terminal/headless/git-write permissions.
    // Every replaced read operation had git-read and therefore needed no approval.
    expect(['write', 'delete', 'terminal', 'headless', 'git-write']).not.toContain(tool.permission);
    expect(operation).toBeDefined();
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
});
