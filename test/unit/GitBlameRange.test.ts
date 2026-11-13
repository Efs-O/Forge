import { describe, expect, it, vi } from 'vitest';
import { makeGitBlameTool } from '../../src/tools/gitReadTools';
import { makeGitReadTool } from '../../src/tools/gitReadTool';

const { run, resolve } = vi.hoisted(() => ({
  run: vi.fn(async () => 'complete blame answer'),
  resolve: vi.fn(async () => ({
    repo: { root: '/selected/repo' },
    paths: ['/selected/repo/file with spaces.ts'],
  })),
}));
vi.mock('../../src/tools/gitRepo', () => ({
  runGit: run,
  resolveGitRequest: resolve,
  repoRelative: () => 'file with spaces.ts',
}));

describe('git_read blame ranges', () => {
  it('advertises positive, 1-based bounds on both public and internal schemas', () => {
    for (const tool of [makeGitBlameTool(), makeGitReadTool()]) {
      const props = tool.definition.function.parameters.properties;
      expect(props['start_line']).toMatchObject({ type: 'integer', minimum: 1 });
      expect(props['end_line']).toMatchObject({ type: 'integer', minimum: 1 });
    }
  });

  it.each([
    [{ start_line: 15, end_line: 20 }, ['-L', '15,20']],
    [{ end_line: 20 }, ['-L', '1,20']],
    [{ start_line: 15 }, ['-L', '15,']],
    [{}, []],
  ])('passes the inclusive range to git in the selected repository: %j', async (range, options) => {
    run.mockClear();
    expect(
      await makeGitReadTool().handler({
        operation: 'blame',
        path: 'file with spaces.ts',
        cwd: '/selected/repo',
        ...range,
      }),
    ).toBe('complete blame answer');
    expect(resolve).toHaveBeenLastCalledWith('git_read', '/selected/repo', ['file with spaces.ts']);
    expect(run).toHaveBeenCalledExactlyOnceWith({ root: '/selected/repo' }, [
      'blame',
      '--line-porcelain',
      ...options,
      '--',
      'file with spaces.ts',
    ]);
  });

  it.each([
    { start_line: 0 },
    { start_line: 1.5 },
    { end_line: -1 },
    { start_line: 9, end_line: 2 },
  ])('refuses invalid ranges before starting git: %j', async (range) => {
    run.mockClear();
    await expect(makeGitBlameTool().handler({ path: 'file.ts', ...range })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
