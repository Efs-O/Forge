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

describe('ToolRegistry.invalidArgs array-item refusal (Fix D)', () => {
  const registry = new ToolRegistry();
  // Mirrors ask_user's `questions`: an array whose entries must be objects.
  const askTool = makeBoolTool('ask_user', {
    prompt: { type: 'string' },
    questions: {
      type: 'array',
      items: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    },
  } as never);

  it('names the field and the offending entry when a string is sent where an object belongs', () => {
    const message = registry.invalidArgs(askTool, {
      prompt: 'Which?',
      questions: ['', ''],
    });
    expect(message).toBe(
      'Error: ask_user "questions" entries must be objects, not entry 1 (string), entry 2 (string). ' +
        'Resend each entry as an object with the fields the schema declares.',
    );
    expect(message?.length).toBeLessThanOrEqual(200);
  });

  it('accepts well-formed object entries, including ones missing a key', () => {
    // A half-built OBJECT still reaches the handler, which owns the better
    // message; only entries that are not objects at all are refused here.
    expect(
      registry.invalidArgs(askTool, { prompt: 'Which?', questions: [{ nope: 1 }] }),
    ).toBeUndefined();
  });

  it('refuses null and nested-array entries and numbers them', () => {
    const message = registry.invalidArgs(askTool, {
      prompt: 'Which?',
      questions: [{ prompt: 'a' }, [''], null],
    });
    expect(message).toContain('entry 2 (array)');
    expect(message).toContain('entry 3 (null)');
  });

  it('caps the entry list at three and counts the rest', () => {
    const message = registry.invalidArgs(askTool, {
      prompt: 'Which?',
      questions: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(message).toContain('entry 3 (string) and 2 more');
    expect(message).not.toContain('entry 4');
    expect(message?.length).toBeLessThanOrEqual(200);
  });

  it('stays within 200 characters for a long tool and field name', () => {
    const long = makeBoolTool('y'.repeat(190), {
      a_really_long_array_field_name: {
        type: 'array',
        items: { type: 'object', properties: {}, required: [] },
      },
    } as never);
    const message = registry.invalidArgs(long, {
      a_really_long_array_field_name: ['x'],
    });
    expect(message?.length).toBeLessThanOrEqual(200);
    // A 190-char tool name plus a 30-char field name cannot fit even the short
    // form, so the refusal falls all the way back to the generic.
    expect(message).toBe('Error: invalid array argument; its entries must be objects.');
  });

  it('leaves an array of scalars alone when the schema declares scalar items', () => {
    const stage = makeBoolTool('stage', {
      paths: { type: 'array', items: { type: 'string' } },
    } as never);
    expect(registry.invalidArgs(stage, { paths: ['a.ts', 'b.ts'] })).toBeUndefined();
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
