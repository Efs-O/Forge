import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type RegisteredTool } from '../../src/tools/ToolRegistry';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
}));

function makeBoolTool(
  name: string,
  properties: Record<string, { type: string }>,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: 'test tool',
        parameters: { type: 'object', properties, required: [] },
      },
    },
    permission: 'read',
    handler: async () => 'should not run',
  };
}

describe('ToolRegistry.invalidArgs boolean refusal (Fix B)', () => {
  const registry = new ToolRegistry();
  const execTool = makeBoolTool('exec_command', {
    command: { type: 'string' },
    background: { type: 'boolean' },
    notify_on_exit: { type: 'boolean' },
  });

  it('names the field and shows the unquoted JSON boolean for "True"', () => {
    const message = registry.invalidArgs(execTool, { command: 'npx', background: 'True' });
    expect(message).toBe('Error: exec_command background="True": use true');
    expect(message?.length).toBeLessThanOrEqual(200);
  });

  it('names the field and shows the unquoted JSON boolean for "False"', () => {
    const message = registry.invalidArgs(execTool, { command: 'npx', background: 'False' });
    expect(message).toBe('Error: exec_command background="False": use false');
  });

  it('uses a short generic instruction for a non-True/False string', () => {
    const message = registry.invalidArgs(execTool, { command: 'npx', background: 'yes' });
    expect(message).toBe(
      'Error: exec_command background="yes": use true or false without quotes',
    );
  });

  it('uses a short generic instruction for a number', () => {
    const message = registry.invalidArgs(execTool, { command: 'npx', background: 1 });
    expect(message).toBe(
      'Error: exec_command background=1: use true or false without quotes',
    );
  });

  it('names each offending field when several booleans are wrong', () => {
    const message = registry.invalidArgs(execTool, {
      command: 'npx',
      background: 'True',
      notify_on_exit: 'False',
    });
    expect(message).toBe(
      'Error: exec_command background="True": use true, notify_on_exit="False": use false',
    );
    expect(message?.length).toBeLessThanOrEqual(200);
  });

  it('stays within 200 characters even for a pathological field list', () => {
    const properties: Record<string, { type: string }> = { command: { type: 'string' } };
    const args: Record<string, unknown> = { command: 'npx' };
    for (let i = 0; i < 6; i += 1) {
      const field = `field_${String(i).padStart(4, '0')}`;
      properties[field] = { type: 'boolean' };
      args[field] = 'True';
    }
    const tool = makeBoolTool('a_very_long_tool_name_for_testing', properties);
    const message = registry.invalidArgs(tool, args);
    expect(message?.length).toBeLessThanOrEqual(200);
    expect(message).toBe(
      'Error: a_very_long_tool_name_for_testing needs JSON true or false, not a string or number. Resend with bare booleans.',
    );
  });

  it('keeps the refusal bounded when the tool name itself is long', () => {
    const tool = makeBoolTool('x'.repeat(220), { background: { type: 'boolean' } });
    const message = registry.invalidArgs(tool, { background: 'True' });
    expect(message).toBe('Error: invalid boolean argument; use unquoted JSON true or false.');
    expect(message?.length).toBeLessThanOrEqual(200);
  });
});

describe('apply_line_edits missing nested field (Fix C)', () => {
  function withSampleFile<T>(fn: (relativePath: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.forge-fixc-test-'));
    const filePath = path.join(dir, 'sample.ts');
    const relativePath = path.relative(process.cwd(), filePath);
    fs.writeFileSync(filePath, 'const value = 1;\n', 'utf8');
    return fn(relativePath).finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('names the operation and missing field, and writes nothing', async () => {
    await withSampleFile(async (relativePath) => {
      const tool = makeApplyLineEditsTool();
      await expect(
        tool.handler({
          path: relativePath,
          operations: [
            {
              end_line: 1,
              expected_lines: ['const value = 1;'],
              replacement_lines: ['const value = 2;'],
            },
          ],
        }),
      ).rejects.toThrow('apply_line_edits: operation 1 is missing start_line');
      expect(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')).toBe(
        'const value = 1;\n',
      );
    });
  });

  it('numbers the offending operation when a later one is missing a field', async () => {
    await withSampleFile(async (relativePath) => {
      const tool = makeApplyLineEditsTool();
      await expect(
        tool.handler({
          path: relativePath,
          operations: [
            {
              start_line: 1,
              end_line: 1,
              expected_lines: ['const value = 1;'],
              replacement_lines: ['const value = 1;'],
            },
            {
              start_line: 1,
              expected_lines: ['const value = 1;'],
              replacement_lines: ['x'],
            },
          ],
        }),
      ).rejects.toThrow('apply_line_edits: operation 2 is missing end_line');
    });
  });

  it('keeps the integer type error for a present but wrong-type start_line', async () => {
    await withSampleFile(async (relativePath) => {
      const tool = makeApplyLineEditsTool();
      await expect(
        tool.handler({
          path: relativePath,
          operations: [
            {
              start_line: '1',
              end_line: 1,
              expected_lines: ['const value = 1;'],
              replacement_lines: ['const value = 2;'],
            },
          ],
        }),
      ).rejects.toThrow('apply_line_edits: operation 1 start_line must be an integer');
      expect(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')).toBe(
        'const value = 1;\n',
      );
    });
  });
});
