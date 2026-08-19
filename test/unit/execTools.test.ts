import { describe, expect, it } from 'vitest';
import { makeExecCommandTool } from '../../src/tools/execTools';

describe('exec_command safety policy', () => {
  it('rejects a denylisted command before spawning it', async () => {
    await expect(
      makeExecCommandTool().handler({
        command: 'git',
        args: ['reset', '--hard'],
        cwd: process.cwd(),
      }),
    ).rejects.toThrow('denylist pattern');
  });

  it('validates structured output controls before spawning', async () => {
    await expect(
      makeExecCommandTool().handler({
        command: process.execPath,
        args: ['-e', 'console.log("should not run")'],
        head_lines: 1,
        tail_lines: 1,
      }),
    ).rejects.toThrow('head_lines and tail_lines cannot be used together');
  });
});
