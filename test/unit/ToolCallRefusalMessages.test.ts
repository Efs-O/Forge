import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type RegisteredTool } from '../../src/tools/ToolRegistry';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { coerceToolArgs, invalidArrayJsonDiagnostic } from '../../src/tools/argCoercion';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
}));

function makeBoolTool(name: string, properties: Record<string, { type: string }>): RegisteredTool {
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

function makeRequiredTool(name: string, required: string[]): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: 'test tool',
        parameters: { type: 'object', properties: {}, required },
      },
    },
    permission: 'read',
    handler: async () => 'should not run',
  };
}

describe('ToolRegistry.invalidArgs boolean refusal (Fix B)', () => {
  const registry = new ToolRegistry();
  const execTool = makeBoolTool('shell', {
    command: { type: 'string' },
    background: { type: 'boolean' },
    notify_on_exit: { type: 'boolean' },
  });

  it('names the field and shows the unquoted JSON boolean for "True"', () => {
    const message = registry.invalidArgs(execTool, { command: 'npx', background: 'True' });
    expect(message).toBe('Error: shell background="True": use true');
    expect(message?.length).toBeLessThanOrEqual(200);
  });

  it('names the field and shows the unquoted JSON boolean for "False"', () => {
    const message = registry.invalidArgs(execTool, { command: 'npx', background: 'False' });
    expect(message).toBe('Error: shell background="False": use false');
  });

  it('uses a short generic instruction for a non-True/False string', () => {
    const message = registry.invalidArgs(execTool, { command: 'npx', background: 'yes' });
    expect(message).toBe('Error: shell background="yes": use true or false without quotes');
  });

  it('uses a short generic instruction for a number', () => {
    const message = registry.invalidArgs(execTool, { command: 'npx', background: 1 });
    expect(message).toBe('Error: shell background=1: use true or false without quotes');
  });

  it('names each offending field when several booleans are wrong', () => {
    const message = registry.invalidArgs(execTool, {
      command: 'npx',
      background: 'True',
      notify_on_exit: 'False',
    });
    expect(message).toBe(
      'Error: shell background="True": use true, notify_on_exit="False": use false',
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

describe('tool argument field locations (PTF F5)', () => {
  const registry = new ToolRegistry();

  it('names the missing path first and shows accepted shapes for file writers', () => {
    for (const tool of [
      makeRequiredTool('append_file', ['path', 'content']),
      makeRequiredTool('write_file', ['path', 'content']),
    ]) {
      const message = registry.invalidArgs(tool, { content: 'x' });
      expect(message).toMatch(/^Error: missing required `path`\./u);
      expect(message).toContain('Accepted shape: { "path": "...", "content": "..." }');
    }
  });

  it('names missing edit_file path and shows both accepted edit shapes', () => {
    const message = registry.invalidArgs(makeRequiredTool('edit_file', ['path']), {
      old_str: 'a',
      new_str: 'b',
    });
    expect(message).toMatch(/^Error: missing required `path`\./u);
    expect(message).toContain('"edits"');
    expect(message).toContain('"old_str"');
  });

  it('reports a string edits value and missing path together, adding malformed JSON status', () => {
    const message = registry.invalidArgs(makeRequiredTool('edit_file', ['path']), {
      edits: '{"old_str"',
    });
    expect(message).toContain('missing required `path`');
    expect(message).toContain('`edits` arrived as a string, not an array and is not valid JSON');
    expect(message).toContain('Accepted shape:');
  });

  it('rejects valid JSON strings for edits without coercing them into arrays', () => {
    const message = registry.invalidArgs(makeRequiredTool('edit_file', ['path']), {
      path: 'a.txt',
      edits: '[]',
    });
    expect(message).toContain('`edits` arrived as a string, not an array.');
    expect(message).not.toContain('not valid JSON');
  });

  it('names unexpected top-level update_plan keys and their location', () => {
    const message = registry.invalidArgs(makeRequiredTool('update_plan', ['items']), {
      items: [{ text: 'x', status: 'pending' }],
      status: 'active',
    });
    expect(message).toContain('unexpected top-level field "status"');
  });

  it('names a missing update_plan key and its top-level location', () => {
    expect(registry.invalidArgs(makeRequiredTool('update_plan', ['items']), {})).toContain(
      'missing required "items" at the top level',
    );
  });

  it('names unexpected and missing update_plan item keys with their items index', () => {
    const tool = makeRequiredTool('update_plan', ['items']);
    expect(
      registry.invalidArgs(tool, { items: [{ text: 'x', status: 'pending', note: 'y' }] }),
    ).toContain('unexpected field "note" at items[0]');
    expect(registry.invalidArgs(tool, { items: [{ text: 'x' }] })).toContain(
      'missing required field "status" at items[0]',
    );
  });
});

describe('apply_line_edits reports invalid JSON array positions', () => {
  const registry = new ToolRegistry();
  const tool = makeApplyLineEditsTool();

  it.each([
    // Trimmed from 5dd2e479: embedded source contains an unescaped quote.
    '[{"end_line":52,"expected_lines":["bad "quote"]}]',
    // Trimmed from 9e9e82dc: the session argument ended before its JSON value closed.
    '[{"start_line":859,"end_line":923,"expected_lines":["/* ---- pelican',
  ])('identifies a JSON.parse position in the operations string', (operations) => {
    const args = coerceToolArgs(tool.definition, { path: 'scene.js', operations });
    expect(registry.invalidArgs(tool, args)).toMatch(/invalid JSON at character index \d+/u);
  });
});

describe('ToolRegistry.invalidArgs malformed array JSON refusal', () => {
  const registry = new ToolRegistry();
  const askTool = makeBoolTool('ask_user', {
    questions: {
      type: 'array',
      items: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    },
  } as never);

  it.each([
    {
      label: 'an extra object closer',
      value: '[{"options": ["...", "You tell me the exact wording to use"]}]}',
      marker: '⟦HERE⟧}',
      position: '[{"options": ["...", "You tell me the exact wording to use"]}]}'.lastIndexOf('}'),
      cause:
        'a closing bracket that does not match the open one (an array closes with ], an object with })',
    },
    {
      label: 'a missing options-array closer',
      value:
        '[{"options": ["...", "(0.16.79 ships without num_ctx; you lose it from your local build)"}]',
      marker: '⟦HERE⟧}',
      position:
        '[{"options": ["...", "(0.16.79 ships without num_ctx; you lose it from your local build)"}]'.lastIndexOf(
          '}',
        ),
      cause:
        'a closing bracket that does not match the open one (an array closes with ], an object with })',
    },
    {
      label: 'a stray inner list',
      value: '[{"options": ["...", "..."], ["", ""]], "prompt": "..."}]',
      marker: '⟦HERE⟧[',
      position: '[{"options": ["...", "..."], ["", ""]], "prompt": "..."}]'.indexOf('["",'),
      cause: undefined,
    },
  ])('points to $label in ask_user questions', ({ value, marker, position, cause }) => {
    const message = registry.invalidArgs(askTool, { questions: value });
    expect(message).toContain(
      `Error: ask_user "questions" has invalid JSON at character index ${position};`,
    );
    expect(message).toContain(marker);
    if (cause) expect(message).toContain(`Likely cause: ${cause}.`);
    else {
      let parseMessage = '';
      try {
        JSON.parse(value);
      } catch (error) {
        parseMessage = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(`Likely cause: JSON.parse says: ${parseMessage}.`);
    }
    expect(message?.endsWith('Resend "questions" as a JSON array, not a string.')).toBe(true);
  });

  it('points out a single-backslash escape in a non-ask_user array field', () => {
    const tool = makeBoolTool('stage', {
      paths: { type: 'array', items: { type: 'string' } },
    } as never);
    const value = '[{"path":"N:\\vs code apps\\Forge"}]';
    const message = registry.invalidArgs(tool, { paths: value });

    expect(message).toContain(
      `"paths" has invalid JSON at character index ${value.indexOf('N:') + 3};`,
    );
    expect(message).toContain('⟦HERE⟧v');
    expect(message).toContain(
      'Likely cause: a single backslash; write \\\\ (for example in Windows paths).',
    );
    expect(message?.endsWith('Resend "paths" as a JSON array, not a string.')).toBe(true);
  });

  it('accepts a Windows path in an ask_user questions array', () => {
    const value = String.raw`[{"prompt":"Use N:\vs code apps\Forge"}]`;
    const args = coerceToolArgs(askTool.definition, { questions: value });

    expect(args['questions']).toEqual([
      { prompt: String.raw`Use N:\vs code apps\Forge` },
    ]);
  });

  it('does not repair a backslash outside a JSON string and shows the original excerpt', () => {
    const tool = makeBoolTool('stage', {
      paths: { type: 'array', items: { type: 'string' } },
    } as never);
    const value = String.raw`[\N]`;
    const args = coerceToolArgs(tool.definition, { paths: value });
    const diagnostic = invalidArrayJsonDiagnostic(value);
    const message = registry.invalidArgs(tool, args);

    expect(args['paths']).toBe(value);
    expect(diagnostic).toBeDefined();
    expect(message).toContain(`near: \`${diagnostic?.excerpt}\``);
  });

  it.each(['[{"prompt":"unfinished', '[{"prompt":"pick"'])(
    'explains a cut-off array: %s',
    (value) => {
      const message = registry.invalidArgs(askTool, { questions: value });
      expect(message).toContain(`at character index ${value.length};`);
      expect(message).toContain('⟦HERE⟧');
      expect(message).toContain('Likely cause: the array is cut off before it closes.');
    },
  );

  it('shows newlines visibly and keeps a long-value refusal under 320 characters', () => {
    const withNewline = '[{"prompt":"before\ninside"}]';
    const newlineMessage = registry.invalidArgs(askTool, { questions: withNewline });
    expect(newlineMessage).toContain('before⟦HERE⟧\\ninside');
    expect(newlineMessage).not.toContain('\n');

    const longValue = `[{"prompt":"${'x'.repeat(1_000)}`;
    const longMessage = registry.invalidArgs(askTool, { questions: longValue });
    expect(longMessage).toContain('⟦HERE⟧');
    expect(longMessage?.length).toBeLessThanOrEqual(320);
    expect(longMessage).not.toContain('x'.repeat(100));
  });

  it('maps a line-and-column-only JSON.parse error to the marked character', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new SyntaxError('Unexpected token in JSON at line 2 column 3');
    });
    try {
      const diagnostic = invalidArrayJsonDiagnostic('[\n  x]');
      expect(diagnostic?.position).toBe(4);
      expect(diagnostic?.excerpt).toContain('⟦HERE⟧x');
    } finally {
      parse.mockRestore();
    }
  });

  it('keeps the generic refusal for non-strings and valid JSON that is not an array', () => {
    const tool = makeBoolTool('stage', {
      paths: { type: 'array', items: { type: 'string' } },
    } as never);
    expect(registry.invalidArgs(tool, { paths: { value: 'x' } })).toBe(
      'Error: stage needs a JSON array for "paths" (got object), not a string holding one. ' +
        'Resend it as a bare array, e.g. ["a", "b"].',
    );
    expect(registry.invalidArgs(tool, { paths: '{"value":"x"}' })).toBe(
      'Error: stage needs a JSON array for "paths" (got string), not a string holding one. ' +
        'Resend it as a bare array, e.g. ["a", "b"].',
    );
  });
});

describe('unavailable tool refusals', () => {
  const registry = new ToolRegistry();

  it('says browser tools are unavailable and names render_html_to_image preview', () => {
    const browserTool: RegisteredTool = {
      definition: {
        type: 'function',
        function: {
          name: 'browser_open',
          description: 'open a page',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      permission: 'browser',
      handler: async () => 'unused',
    };
    expect(() => registry.assertAllowed(browserTool, new Set(['read']))).toThrow(
      'ToolRegistry: tool "browser_open" is not available in this conversation. Use render_html_to_image with mode: "preview".',
    );
  });

  it('does not invent an alternative for another unavailable tool', () => {
    const unavailable = makeRequiredTool('write_file', []);
    const tool: RegisteredTool = { ...unavailable, permission: 'write' };
    expect(() => registry.assertAllowed(tool, new Set(['read']))).toThrow(
      'ToolRegistry: tool "write_file" is not available in this conversation.',
    );
  });

  it('names an argument-derived permission when the tool base permission is granted', () => {
    const manageJobs: RegisteredTool = {
      ...makeRequiredTool('manage_jobs', ['action']),
      permission: 'read',
      additionalPermissionsForArgs: (args) => (args['action'] === 'delete' ? ['delete'] : []),
    };
    expect(() =>
      registry.assertAllowed(manageJobs, new Set(['read']), { action: 'delete' }),
    ).toThrow(
      'ToolRegistry: manage_jobs action "delete" needs the "delete" permission, which this conversation does not have.',
    );
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
              expected_lines: ['const value = 1;'],
              replacement_lines: ['const value = 2;'],
            },
          ],
        }),
      ).rejects.toThrow('apply_line_edits: operation 1 is missing start_line or end_line');
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
              expected_lines: ['const value = 1;'],
              replacement_lines: ['x'],
            },
          ],
        }),
      ).rejects.toThrow('apply_line_edits: operation 2 is missing start_line or end_line');
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
