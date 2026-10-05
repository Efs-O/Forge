import { describe, expect, it } from 'vitest';
import { describeForgeToolProgram } from '../../src/tools/execHints';
import { makeExecCommandTool } from '../../src/tools/execTools';
import { ToolRegistry, type RegisteredTool } from '../../src/tools/ToolRegistry';

describe('exec_command Forge tool hint', () => {
  it('matches registered tool basenames exactly after stripping extensions', async () => {
    const names = ['find_files', 'search_code', 'read_file'];
    expect(describeForgeToolProgram('C:\\forge\\find_files.exe', names)).toContain(
      '`find_files` is a Forge tool; call it directly',
    );
    expect(describeForgeToolProgram('search_code.cmd', names)).toContain(
      '`search_code` is a Forge tool; call it directly',
    );
    expect(describeForgeToolProgram('my_search_code_helper', names)).toBeUndefined();
    expect(describeForgeToolProgram('delete_file', names)).toBeUndefined();
    const registry = new ToolRegistry();
    const findFiles: RegisteredTool = {
      definition: {
        type: 'function',
        function: {
          name: 'find_files',
          description: 'Find files.',
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
      },
      permission: 'read',
      handler: async () => 'unused',
    };
    registry.register(findFiles);
    await expect(
      makeExecCommandTool(
        () => false,
        () => registry.names(),
      ).handler({
        command: 'find_files.exe',
        args: [],
        cwd: process.cwd(),
      }),
    ).rejects.toThrow('`find_files` is a Forge tool; call it directly');
  });
});
