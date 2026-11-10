import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type RegisteredTool } from '../../src/tools/ToolRegistry';
import { isFailureResult } from '../../src/sidebar/toolResultView';
import { classifyResult } from '../../src/sidebar/compactionLedger';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { toolErrorText, describeToolIssues } from '../../src/tools/toolErrorText';
import { JobSchema } from '../../src/jobs/jobSchema';
import { makeAskUserTool } from '../../src/tools/askUserTool';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { makeShellTool } from '../../src/tools/shellTool';
import { makeStageTool } from '../../src/tools/gitTools';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
  // `compactionLedger` reaches the Logger, which builds its output channel on import.
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      clear: () => undefined,
      dispose: () => undefined,
    }),
  },
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

describe('ToolRegistry.invalidArgs missing-argument refusal', () => {
  const registry = new ToolRegistry();

  /** A tool whose static schema offers four actions and whose `describe()` narrows
   * them to the two this window actually has — the message_chat case. */
  const enumTool = (offered: string[]): RegisteredTool => ({
    definition: {
      type: 'function',
      function: {
        name: 'message_chat',
        description: 'test tool',
        parameters: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['list', 'send', 'new', 'steer'] } },
          required: ['action'],
        },
      },
    },
    describe: () => ({
      type: 'function',
      function: {
        name: 'message_chat',
        description: 'test tool',
        parameters: {
          type: 'object',
          properties: { action: { type: 'string', enum: offered } },
          required: [],
        },
      },
    }),
    permission: 'read',
    handler: async () => 'should not run',
  });

  it('names the values the model was offered, not the ones config switched off', () => {
    // The static schema lists four actions; this window has two. Offering `new`
    // to a window where it is off would be a second refusal for the price of
    // the first, so the values come from `describe()` — the definition the turn
    // was actually shown.
    expect(registry.invalidArgs(enumTool(['list', 'send']), { message: 'hi' })).toBe(
      'Error: message_chat is missing required argument "action" (one of: list, send). ' +
        'Resend the call with it set.',
    );
    expect(registry.invalidArgs(enumTool(['list', 'send', 'new', 'steer']), {})).toContain(
      '(one of: list, send, new, steer)',
    );
  });

  it('says the same thing as before for a field with no enum, and for two fields', () => {
    expect(registry.invalidArgs(makeRequiredTool('fetch_page', ['url']), {})).toBe(
      'Error: fetch_page is missing required argument "url". Resend the call with it set.',
    );
    expect(registry.invalidArgs(makeRequiredTool('fetch_page', ['url', 'max_chars']), {})).toBe(
      'Error: fetch_page is missing required arguments "url", "max_chars". ' +
        'Resend the call with them set.',
    );
  });
});

describe('ToolRegistry.invalidArgs unknown-argument refusal', () => {
  const registry = new ToolRegistry();
  const fullSearchCode: RegisteredTool = {
    definition: {
      type: 'function',
      function: {
        name: 'search_code',
        description: 'Search source.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            literal: { type: 'boolean' },
            include: { type: 'string' },
            output: { type: 'string' },
            context: { type: 'number' },
            ignore_case: { type: 'boolean' },
            max_results: { type: 'number' },
            offset: { type: 'number' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async () => 'unused',
  };

  it('refuses one undeclared argument and lists keys in advertised schema order', () => {
    const searchCode: RegisteredTool = {
      definition: {
        type: 'function',
        function: {
          name: 'search_code',
          description: 'Search source.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' }, include: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
      permission: 'read',
      handler: async () => 'unused',
    };
    expect(registry.invalidArgs(searchCode, { query: 'needle', path: 'src' })).toBe(
      'Error: search_code: unknown argument "path"; this tool takes: query, include. ' +
        'Nothing ran. Resend the call without it, or use the argument that means what you intended.',
    );
  });

  it('explains when an unknown key wraps the tool arguments', () => {
    expect(
      registry.invalidArgs(fullSearchCode, {
        context: 0,
        output: 'content',
        queries: { query: 'sumPricesR4|totalPricesR4' },
      }),
    ).toBe(
      'Error: search_code: unknown argument "queries"; its value holds this tool\'s own arguments (query), ' +
        'which go at the top level, not inside "queries". This tool takes: query, literal, include, output, ' +
        'context, ignore_case, max_results, offset. Nothing ran. Resend the call with query moved out of "queries".',
    );
  });

  it('keeps the existing single-unknown refusal for other value shapes', () => {
    const expected =
      'Error: search_code: unknown argument "wrap"; this tool takes: query, literal, include, output, ' +
      'context, ignore_case, max_results, offset. Nothing ran. Resend the call without it, or use the argument ' +
      'that means what you intended.';
    expect(registry.invalidArgs(fullSearchCode, { wrap: 'x' })).toBe(expected);
    expect(registry.invalidArgs(fullSearchCode, { wrap: { query: 'x', bogus: 1 } })).toBe(expected);
    expect(registry.invalidArgs(fullSearchCode, { wrap: {} })).toBe(expected);
    expect(registry.invalidArgs(fullSearchCode, { wrap: ['query'] })).toBe(expected);
    expect(registry.invalidArgs(fullSearchCode, { query: 'a', wrap: { query: 'b' } })).toBe(expected);
  });

  it('keeps the plural refusal when multiple unknown arguments include wrapped keys', () => {
    expect(registry.invalidArgs(fullSearchCode, { wrap: { query: 'x' }, extra: true })).toBe(
      'Error: search_code: unknown arguments "wrap", "extra"; this tool takes: query, literal, include, ' +
        'output, context, ignore_case, max_results, offset. Nothing ran. Resend the call without them, or use the ' +
        'arguments that mean what you intended.',
    );
  });

  it('refuses multiple unknown arguments in call order, before other schema checks', () => {
    expect(registry.invalidArgs(makeStageTool(), { paths: ['a.txt'], repo: 'x', root: 'y' })).toBe(
      'Error: stage: unknown arguments "repo", "root"; this tool takes: paths, cwd. ' +
        'Nothing ran. Resend the call without them, or use the arguments that mean what you intended.',
    );
  });

  it('uses ask_user declared keys when refusing its question and ask aliases', () => {
    const tool = makeAskUserTool(new UserQuestionService());
    expect(registry.invalidArgs(tool, { prompt: 'Which?', question: 'Which?', ask: 'x' })).toBe(
      'Error: ask_user: unknown arguments "question", "ask"; this tool takes: prompt, placeholder, options, questions. ' +
        'Nothing ran. Resend the call without them, or use the arguments that mean what you intended.',
    );
  });

  it('allows shell.shell from the Windows advertised schema', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const shell = makeShellTool({ platform: 'win32' });
      expect(Object.keys(shell.describe!().function.parameters.properties)).toContain('shell');
      expect(registry.invalidArgs(shell, { command: 'git status', shell: 'bash' })).toBeUndefined();
    } finally {
      platform.mockRestore();
    }
  });

  it('allows an undefined extra value and schemas without additionalProperties false', () => {
    expect(
      registry.invalidArgs(makeStageTool(), { paths: ['a.txt'], stray: undefined }),
    ).toBeUndefined();
    expect(
      registry.invalidArgs(makeBoolTool('open_schema', { path: { type: 'string' } }), {
        path: 'a.txt',
        extra: true,
      }),
    ).toBeUndefined();
  });

  it('still coerces a quoted boolean before checking unknown keys', () => {
    const tool = makeBoolTool('flag_tool', { enabled: { type: 'boolean' } });
    tool.definition.function.parameters.additionalProperties = false;
    const args: Record<string, unknown> = { enabled: 'true' };
    expect(registry.invalidArgs(tool, args)).toBeUndefined();
    expect(args.enabled).toBe(true);
  });
});

describe('ToolRegistry.invalidArgs quoted-type refusals', () => {
  const registry = new ToolRegistry();
  const execTool = makeBoolTool('shell', {
    command: { type: 'string' },
    background: { type: 'boolean' },
    notify_on_exit: { type: 'boolean' },
  });

  it('accepts "True" as a declared boolean', () => {
    const args = { command: 'npx', background: 'True' };
    expect(registry.invalidArgs(execTool, args)).toBeUndefined();
    expect(args).toEqual({ command: 'npx', background: true });
  });

  it('accepts "False" as a declared boolean', () => {
    const args = { command: 'npx', background: 'False' };
    expect(registry.invalidArgs(execTool, args)).toBeUndefined();
    expect(args).toEqual({ command: 'npx', background: false });
  });

  it.each([
    ['yes', 'yes'],
    ['no', 'no'],
    ['one', '1'],
    ['zero', '0'],
    ['leading space', ' true'],
    ['trailing space', 'true '],
    ['empty string', ''],
  ])('refuses %s for a declared boolean', (_label, value) => {
    expect(registry.invalidArgs(execTool, { command: 'npx', background: value })).toBe(
      'Error: shell: "background" must be a JSON boolean, not a string. Resend the call with background as true or false.',
    );
  });

  it('refuses other string spellings with the same required JSON shape', () => {
    expect(registry.invalidArgs(execTool, { command: 'npx', background: 'yes' })).toBe(
      'Error: shell: "background" must be a JSON boolean, not a string. Resend the call with background as true or false.',
    );
  });

  it('names the actual JSON type when a number is sent for a boolean', () => {
    expect(registry.invalidArgs(execTool, { command: 'npx', background: 1 })).toBe(
      'Error: shell: "background" must be a JSON boolean, not a number. Resend the call with background as true or false.',
    );
  });

  it('refuses the first wrong field and lets a corrected retry expose the next one', () => {
    const args = { command: 'npx', background: 'yes', notify_on_exit: 'no' };
    expect(registry.invalidArgs(execTool, args)).toBe(
      'Error: shell: "background" must be a JSON boolean, not a string. Resend the call with background as true or false.',
    );
    expect(registry.invalidArgs(execTool, { ...args, background: false })).toContain(
      '"notify_on_exit" must be a JSON boolean',
    );
  });

  it('does not cap or replace the source correction message for long tool names', () => {
    const tool = makeBoolTool('x'.repeat(220), { background: { type: 'boolean' } });
    expect(registry.invalidArgs(tool, { background: 'yes' })).toBe(
      `Error: ${'x'.repeat(220)}: "background" must be a JSON boolean, not a string. ` +
        'Resend the call with background as true or false.',
    );
  });

  it('includes the declared numeric range when refusing a quoted integer', () => {
    const tool = makeBoolTool('browser_inspect', {
      max: { type: 'integer', minimum: 1, maximum: 500 },
    });
    expect(registry.invalidArgs(tool, { max: '25' })).toBe(
      'Error: browser_inspect: "max" must be a JSON integer in range 1 to 500, not a string. ' +
        'Resend the call with max as 1.',
    );
  });

  it('refuses an integer beyond the declared range with the allowed bounds', () => {
    const tool = makeBoolTool('browser_inspect', {
      max: { type: 'integer', minimum: 1, maximum: 500 },
    });
    expect(registry.invalidArgs(tool, { max: 501 })).toBe(
      'Error: browser_inspect: "max" must be within 1 to 500. Resend it in that range.',
    );
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
    for (const tool of [makeRequiredTool('write_file', ['path', 'content'])]) {
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

describe('ToolRegistry.invalidArgs refuses quoted JSON types', () => {
  const registry = new ToolRegistry();
  const editTool = makeApplyLineEditsTool();
  const askTool = makeBoolTool('ask_user', {
    questions: {
      type: 'array',
      items: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    },
  } as never);

  it('refuses operations sent as a JSON string with the array example', () => {
    expect(registry.invalidArgs(editTool, { operations: '[{"path":"scene.js"}]' })).toBe(
      'Error: apply_line_edits: "operations" must be a JSON array, not a string. ' +
        'Resend the call with operations as [].',
    );
  });

  it('refuses malformed array JSON without repairing its backslashes', () => {
    const value = String.raw`[{"prompt":"Use N:\vs code apps\Forge"}]`;
    expect(registry.invalidArgs(askTool, { questions: value })).toBe(
      'Error: ask_user: "questions" must be a JSON array, not a string. ' +
        'Resend the call with questions as [].',
    );
  });

  it('refuses quoted non-boolean strings using the JSON boolean example', () => {
    const tool = makeBoolTool('probe', { enabled: { type: 'boolean' } } as never);
    expect(registry.invalidArgs(tool, { enabled: 'yes' })).toBe(
      'Error: probe: "enabled" must be a JSON boolean, not a string. ' +
        'Resend the call with enabled as true or false.',
    );
  });

  it('refuses quoted numbers using a JSON number example', () => {
    const tool = makeBoolTool('probe', { count: { type: 'integer' } } as never);
    expect(registry.invalidArgs(tool, { count: '5' })).toBe(
      'Error: probe: "count" must be a JSON integer, not a string. ' +
        'Resend the call with count as 1.',
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

/**
 * Lane 5 phase 5.5 (docs/plans/V1_FINISH_PLAN.md): two tools used to answer a
 * limit breach with the raw Zod issue array — hundreds of characters of JSON for
 * one wrong field — and the model read that as data and re-sent the same shape.
 * These are the three shapes the audit found (`too_big`, `invalid_type`,
 * `unrecognized_keys`) plus the ones the formatter must not touch: a custom
 * rule's own advice, and an ordinary thrown error.
 */
describe('a schema refusal comes back as plain lines', () => {
  const askTool = makeAskUserTool(new UserQuestionService());
  const context = { beforeMutate: vi.fn() };

  async function thrownFromAskUser(args: Record<string, unknown>): Promise<unknown> {
    try {
      await askTool.handler(args, context);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('a too-long description names its own length, the limit and the fix', async () => {
    const args = {
      prompt: 'Deploy?',
      questions: [
        {
          prompt: 'Which?',
          options: [{ label: 'a', description: 'z'.repeat(512) }, 'b'],
        },
      ],
    };
    const error = await thrownFromAskUser(args);
    expect(error).toBeInstanceOf(z.ZodError);
    expect(toolErrorText('ask_user', error, args)).toBe(
      'Error: ask_user questions[0].options[0].description is 512 characters; the limit is 500. ' +
        'Shorten it and resend.',
    );
  });

  it('a wrong type says what arrived and what was wanted', async () => {
    const args = { prompt: 'x', questions: 42 };
    const text = toolErrorText('ask_user', await thrownFromAskUser(args), args);
    expect(text.split('\n')[0]).toBe(
      'Error: ask_user questions is a number, not an array. ' +
        'Resend it in the shape the schema declares.',
    );
  });

  it('an undeclared field is named and told to go', async () => {
    const args = { prompt: 'x', hidden: true };
    const text = toolErrorText('ask_user', await thrownFromAskUser(args), args);
    expect(text).toBe(
      'Error: ask_user has a field it did not declare: "hidden". Remove it and resend.',
    );
  });

  it('one line per problem, and never the JSON block', async () => {
    const args = { questions: 'not an array', bogus: 1 };
    const text = toolErrorText('ask_user', await thrownFromAskUser(args), args);
    const lines = text.split('\n');
    expect(lines.length).toBeGreaterThan(2);
    expect(
      lines.every(
        (line) =>
          line.startsWith('Error: ask_user ') || line === 'Resend the call with these fixed.',
      ),
    ).toBe(true);
    // The thing this phase exists to stop: a JSON array of issues as the result.
    expect(text).not.toMatch(/"code"\s*:|"path"\s*:|"message"\s*:|\{/u);
  });

  it('a custom rule keeps its own advice, because it already names the fix', async () => {
    const args = {
      prompt: 'p',
      options: [
        { label: 'a', recommended: true },
        { label: 'b', recommended: true },
      ],
    };
    const text = toolErrorText('ask_user', await thrownFromAskUser(args), args);
    expect(text).toContain('can recommend only one option');
    expect(text).toContain('Error: ask_user options');
  });

  it('an ordinary thrown error keeps its own message', () => {
    expect(toolErrorText('shell', new Error('bash exited with code 1'))).toBe(
      'Error: bash exited with code 1',
    );
    expect(toolErrorText('shell', 'a string thrown')).toBe('Error: a string thrown');
  });

  it('prints eight problems and counts the rest', () => {
    const args = { values: Array.from({ length: 10 }, () => 42) };
    const parsed = z.object({ values: z.array(z.string()) }).safeParse(args);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected refusal');
    const text = toolErrorText('probe', parsed.error, args);
    const lines = text.split('\n');
    expect(lines.filter((line) => line.startsWith('Error: probe values['))).toHaveLength(8);
    expect(text).toContain('has 2 more argument problem(s).');
  });
});

/**
 * The text is the record. Four consumers decide whether a call failed by reading the
 * result string — the transcript row's error badge (`sessionProjections.toolIsError`),
 * `tool_failures` in `/stats` and the per-session usage record, the compaction ledger's
 * account of what the model actually did, and `isFailureResult` itself — so a refusal
 * the model was told about in words has to carry the marker they all key on.
 * BL-036: the argument refusals introduced with the strict-argument change did not.
 */
describe('a refusal before the handler runs is recorded as a failure', () => {
  const registry = new ToolRegistry();
  const tool = makeBoolTool('probe', {
    enabled: { type: 'boolean' },
    count: { type: 'integer', minimum: 1, maximum: 8 },
  });

  it.each([
    ['a quoted invalid boolean string', { enabled: 'yes' }],
    ['an integer outside the declared range', { count: 9 }],
    ['a fractional integer', { count: 1.5 }],
  ])('marks %s failed for the row, the stats and the ledger', (_label, args) => {
    const refusal = registry.invalidArgs(tool, args);
    expect(typeof refusal).toBe('string');
    expect(refusal).toMatch(/^Error: /u);
    expect(isFailureResult(refusal as string), refusal).toBe(true);
    expect(classifyResult(refusal), refusal).toBe('failed');
  });
});

/**
 * A union refusal has to name the values it accepts.
 *
 * `manage_jobs` with `schedule: {kind: "hourly"}` used to answer
 * `schedule.kind Invalid input` — every accepted kind was left for the model to
 * guess, and it guessed again (lab run U3a, 2026-11-09). The kinds come from the
 * union's own options, in `jobs/jobSchema.ts`.
 */
describe("a value that matches none of a union's shapes", () => {
  const Plain = z.object({
    on_change: z.union([
      z.object({ kind: z.literal('notify') }),
      z.object({ kind: z.literal('summarize'), focus: z.array(z.string()) }),
    ]),
  });

  function firstLine(issues: z.ZodIssue[], args: Record<string, unknown>): string {
    return describeToolIssues('manage_jobs', issues, args)[0];
  }

  function refused(
    schema: z.ZodType,
    args: Record<string, unknown>,
  ): [z.ZodIssue[], Record<string, unknown>] {
    const parsed = schema.safeParse(args);
    expect(parsed.success).toBe(false);
    return [(parsed as { error: z.ZodError }).error.issues, args];
  }

  it('names every kind a job schedule accepts', () => {
    const candidate = {
      version: 1 as const,
      id: 'job-1',
      name: 'watch releases',
      after: 'stay_awake' as const,
      schedule: { kind: 'hourly' },
      check: { kind: 'none' },
      on_change: { kind: 'notify' },
    };
    const [issues, args] = refused(JobSchema, candidate as unknown as Record<string, unknown>);
    expect(firstLine(issues, args)).toBe(
      'Error: manage_jobs schedule.kind must be one of "interval", "daily", "weekly"; received "hourly".',
    );
  });

  it('names every kind a job check accepts', () => {
    const candidate = {
      version: 1 as const,
      id: 'job-1',
      name: 'watch releases',
      after: 'stay_awake' as const,
      schedule: { kind: 'interval', minutes: 15 },
      check: { kind: 'nope' },
      on_change: { kind: 'notify' },
    };
    const [issues, args] = refused(JobSchema, candidate as unknown as Record<string, unknown>);
    expect(firstLine(issues, args)).toBe(
      'Error: manage_jobs check.kind must be one of "github_release", "github_issue", ' +
        '"hf_discussion", "disk_space", "tool_usage", "none"; received "nope".',
    );
  });

  it('names the values a plain union refused, and the field they belong to', () => {
    const [issues, args] = refused(Plain, { on_change: { kind: 'shout' } });
    expect(firstLine(issues, args)).toContain('kind must be one of "notify", "summarize"');
    expect(firstLine(issues, args)).toContain('received "shout"');
  });

  it('still tells the model where to look when the union says nothing', () => {
    const Loose = z.object({
      schedule: z.discriminatedUnion('kind', [z.object({ kind: z.literal('daily') })]),
    });
    const [issues, args] = refused(Loose, { schedule: { kind: 'hourly' } });
    const line = firstLine(issues, args);
    expect(line).toContain('is not one of the shapes this field accepts');
    expect(line).not.toContain('Invalid input');
  });
});
