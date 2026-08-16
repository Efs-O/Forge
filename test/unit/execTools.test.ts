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
});
