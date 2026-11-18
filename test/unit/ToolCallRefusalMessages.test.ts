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

function makeMarkupCommitTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'commit',
        description: 'Create a commit or amend the previous one.',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' }, amend: { type: 'boolean' } },
          required: ['message'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async () => 'unused',
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

describe('ToolRegistry.invalidArgs union argument types', () => {
  const registry = new ToolRegistry();
  // `desktop_focus_window` takes an HWND, and `desktop_windows` prints ids
  // unquoted, so the model sends a number as often as a string. Both must pass,
  // and a type in NEITHER arm must still be refused — an array `type` that the
  // validator skipped would let `true` through to the handler.
  const focusLike: RegisteredTool = {
    definition: {
      type: 'function',
      function: {
        name: 'desktop_focus_window',
        description: 'test tool',
        parameters: {
          type: 'object',
          properties: { window_id: { type: ['string', 'number'] as unknown as string } },
          required: [],
        },
      },
    },
    permission: 'read',
    handler: async () => 'should not run',
  };

  it('accepts either listed type and refuses what is in neither', () => {
    expect(registry.invalidArgs(focusLike, { window_id: '1312420' })).toBeUndefined();
    expect(registry.invalidArgs(focusLike, { window_id: 1312420 })).toBeUndefined();
    expect(registry.invalidArgs(focusLike, { window_id: true })).toContain(
      'must be a JSON string or number, not a boolean',
    );
    expect(registry.invalidArgs(focusLike, { window_id: {} })).toContain(
      'must be a JSON string or number',
    );
  });
});

describe('ToolRegistry.invalidArgs unknown-argument refusal', () => {
  const registry = new ToolRegistry();
  const fullSearchCode: RegisteredTool = {
    definition: {
      type: 'function',
      function: {
        name: 'grep_search',
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
          name: 'grep_search',
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
    expect(registry.invalidArgs(searchCode, { query: 'needle', dir: 'src' })).toBe(
      'Error: grep_search: unknown argument "dir"; this tool takes: query, include. ' +
        'Nothing ran. Resend the call without it, or use the argument that means what you intended.',
    );
  });

  // Measured 2026-11-16: 4 of the day's 21 tool refusals were `path` or `glob`
  // on grep_search — the name every other Forge file tool uses for its target,
  // and ripgrep's own flag. Both carry exactly what `include` carries, so the
  // search now runs instead of costing the model a round.
  it('rewrites grep_search path and glob onto include, leaving the rest of the call alone', () => {
    const withPath = { query: 'needle', path: 'src' };
    expect(registry.invalidArgs(fullSearchCode, withPath)).toBeUndefined();
    expect(withPath).toEqual({ query: 'needle', include: 'src' });
    const withGlob = { query: 'needle', glob: '*.ts' };
    expect(registry.invalidArgs(fullSearchCode, withGlob)).toBeUndefined();
    expect(withGlob).toEqual({ query: 'needle', include: '*.ts' });
  });

  // Two filters, one meaning: only the caller knows which it wanted, so the
  // rewrite stands down and the ordinary refusal fires.
  it('refuses grep_search path when include is already in the call', () => {
    expect(
      registry.invalidArgs(fullSearchCode, { query: 'needle', include: '**/*.ts', path: 'src' }),
    ).toContain('unknown argument "path"');
  });

  // A wrong key whose value could not be the argument it resembles — an array of
  // command names, a label — must never be renamed: the guess would run the
  // wrong thing. The refusal names the argument instead. Measured 2026-11-16:
  // `shell subject` and `read_file max_chars`, both left guessing at a round.
  it('names the argument a wrong key was reaching for, and stops guessing when it is already there', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const readOnly: RegisteredTool = {
      definition: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, start_line: { type: 'integer' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      permission: 'read',
      handler: async () => 'unused',
    };
    try {
      const subject = registry.invalidArgs(makeShellTool({ platform: 'win32' }), {
        subject: 'list files',
      });
      expect(subject).toContain('unknown argument "subject"');
      expect(subject).toContain('did you mean "command"');
      expect(subject).toContain('Resend the call with "command" instead.');
      const names = registry.invalidArgs(makeShellTool({ platform: 'win32' }), {
        command: 'ls',
        command_names: ['ls'],
      });
      expect(names).toContain('unknown argument "command_names"');
      expect(names).not.toContain('did you mean');
      const cap = registry.invalidArgs(readOnly, { path: 'a.ts', max_chars: 4000 });
      // The whole text is pinned: a hint that reads as one quoted key is one a
      // weak model sends back verbatim, and the round is spent again.
      expect(cap).toBe(
        'Error: read_file: unknown argument "max_chars"; did you mean "start_line" or "end_line"? ' +
          'this tool takes: path, start_line. Nothing ran. Resend the call with "start_line" or "end_line" instead.',
      );
    } finally {
      platform.mockRestore();
    }
  });

  // The rewrite is only for a name carrying what `include` carries. A list of
  // paths is not a filter this tool can run, so the refusal still fires.
  it('leaves a non-string grep_search path for the ordinary refusal', () => {
    expect(registry.invalidArgs(fullSearchCode, { query: 'needle', path: ['src', 'test'] })).toContain(
      'unknown argument "path"',
    );
  });

  // A lone `=`, and a doubled one, are not repairs: the first matches nothing,
  // the second reaches for an argument called `=query`.
  it('refuses a bare = key and a doubled one', () => {
    expect(registry.invalidArgs(fullSearchCode, { query: 'a', '=': 'b' })).toContain(
      'unknown argument "="',
    );
    expect(registry.invalidArgs(fullSearchCode, { query: 'a', '==query': 'b' })).toContain(
      'unknown argument "==query"',
    );
  });

  // A key written as `=query` is the same argument with a stray `=` from a model
  // rendering `--query=` or `<parameter name=query>` as text. Measured once.
  it('repairs a key that arrived as =query, and still refuses it beside query', () => {
    const args = { context: 0, '=query': 'sumPrices' };
    expect(registry.invalidArgs(fullSearchCode, args)).toBeUndefined();
    expect(args).toEqual({ context: 0, query: 'sumPrices' });
    expect(registry.invalidArgs(fullSearchCode, { query: 'a', '=query': 'b' })).toContain(
      'unknown argument "=query"',
    );
  });

  it.each(['amend</parameter', 'amend</parameter>'])(
    'repairs only a declared argument followed by leaked parameter markup (%s)',
    (key) => {
      expect(
        registry.invalidArgs(makeMarkupCommitTool(), { message: 'update', [key]: true }),
      ).toBeUndefined();
    },
  );

  it('validates the repaired value against the declared argument schema', () => {
    expect(
      registry.invalidArgs(makeMarkupCommitTool(), {
        message: 'update',
        'amend</parameter': 'yes',
      }),
    ).toBe(
      'Error: commit: "amend" must be a JSON boolean, not a string. Resend the call with amend as true or false.',
    );
  });

  it('refuses a mapped value that is tool-call markup with the exact resend instruction', () => {
    expect(
      registry.invalidArgs(makeMarkupCommitTool(), {
        message: 'update',
        'amend</parameter': '<parameter name>',
      }),
    ).toBe(
      'commit: argument "amend" arrived as tool-call markup (<parameter name>), not a value. Send it again as plain JSON.',
    );
    expect(
      registry.invalidArgs(makeMarkupCommitTool(), {
        message: 'update',
        'amend</parameter>': '<parameter name=amend>',
      }),
    ).toBe(
      'commit: argument "amend" arrived as tool-call markup (<parameter name=amend>), not a value. Send it again as plain JSON.',
    );
  });

  it('still refuses a normal unknown argument after parameter-markup repair', () => {
    expect(
      registry.invalidArgs(makeMarkupCommitTool(), { message: 'update', amendment: true }),
    ).toBe(
      'Error: commit: unknown argument "amendment"; this tool takes: message, amend. ' +
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
      'Error: grep_search: unknown argument "queries"; its value holds this tool\'s own arguments (query), ' +
        'which go at the top level, not inside "queries". This tool takes: query, literal, include, output, ' +
        'context, ignore_case, max_results, offset. Nothing ran. Resend the call with query moved out of "queries".',
    );
  });

  it('keeps the existing single-unknown refusal for other value shapes', () => {
    const expected =
      'Error: grep_search: unknown argument "wrap"; this tool takes: query, literal, include, output, ' +
      'context, ignore_case, max_results, offset. Nothing ran. Resend the call without it, or use the argument ' +
      'that means what you intended.';
    expect(registry.invalidArgs(fullSearchCode, { wrap: 'x' })).toBe(expected);
    expect(registry.invalidArgs(fullSearchCode, { wrap: { query: 'x', bogus: 1 } })).toBe(expected);
    expect(registry.invalidArgs(fullSearchCode, { wrap: {} })).toBe(expected);
    expect(registry.invalidArgs(fullSearchCode, { wrap: ['query'] })).toBe(expected);
    expect(registry.invalidArgs(fullSearchCode, { query: 'a', wrap: { query: 'b' } })).toBe(
      expected,
    );
  });

  it('keeps the plural refusal when multiple unknown arguments include wrapped keys', () => {
    expect(registry.invalidArgs(fullSearchCode, { wrap: { query: 'x' }, extra: true })).toBe(
      'Error: grep_search: unknown arguments "wrap", "extra"; this tool takes: query, literal, include, ' +
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
    ['empty string', ''],
    ['a word with spaces', ' not a boolean '],
  ])('refuses %s for a declared boolean', (_label, value) => {
    expect(registry.invalidArgs(execTool, { command: 'npx', background: value })).toBe(
      'Error: shell: "background" must be a JSON boolean, not a string. Resend the call with background as true or false.',
    );
  });

  // Spaces around the word carry no meaning: the model that wrote `background: "TRUE "`
  // meant the job to run in the background, and a refusal costs a round either way.
  it.each([
    ['true ', true],
    [' true', true],
    ['  TRUE  ', true],
    [' false ', false],
  ])('accepts the quoted boolean %j whatever spaces surround it', (value, expected) => {
    const args = { command: 'npx', background: value };
    expect(registry.invalidArgs(execTool, args)).toBeUndefined();
    expect(args.background).toBe(expected);
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

/**
 * A parameter block cut off mid-write leaves the argument holding the call's own
 * markup. `read_file` was refused this way on 2026-11-14: `end_line` arrived as
 * `"237\n</parameter>\nparameter=path>"` and the type sentence told the model to
 * resend it "as 1" — a number nobody sent, while the one that was sent sat
 * inside the value being refused. The refusal now quotes what arrived.
 */
describe('an argument that swallowed the markup after it', () => {
  const registry = new ToolRegistry();
  const readTool = makeBoolTool('read_file', {
    path: { type: 'string' },
    start_line: { type: 'integer' },
    end_line: { type: 'integer' },
    numbered: { type: 'boolean' },
  });

  it('quotes what arrived, names the cut-off, and stops inventing a number', () => {
    const message = registry.invalidArgs(readTool, {
      path: 'test/unit/mcpBridge.test.ts',
      end_line: '237\n</parameter>\nparameter=path>',
    });
    expect(message).toContain('"end_line" must be a JSON integer, not a string.');
    expect(message).toContain('It received "237\\n</parameter>\\nparameter=path>"');
    expect(message).toContain("that is the call's own markup, so the block was cut off");
    expect(message).toContain('the number you meant is inside the text quoted above');
    expect(message).not.toContain('as 1.');
  });

  it('fires for a boolean whose value holds markup too', () => {
    const message = registry.invalidArgs(readTool, {
      path: 'a.ts',
      numbered: 'true</parameter>',
    });
    expect(message).toContain('"numbered" must be a JSON boolean, not a string.');
    expect(message).toContain('It received "true</parameter>"');
  });

  it('keeps the plain sentence for a quoted number with no markup in it', () => {
    expect(registry.invalidArgs(readTool, { path: 'a.ts', end_line: '237' })).toBe(
      'Error: read_file: "end_line" must be a JSON integer, not a string. ' +
        'Resend the call with end_line as 1.',
    );
    // A stray newline is not markup evidence: no cut-off is claimed.
    expect(registry.invalidArgs(readTool, { path: 'a.ts', end_line: '237\n' })).not.toContain(
      'cut off',
    );
  });

  it('does not diagnose a stringified array as a cut-off block', () => {
    // The other mistake this could be confused with: a pretty-printed array sent
    // as a string, which can hold a `<` inside its own text.
    const tool = makeBoolTool('apply_line_edits', {
      operations: { type: 'array', items: { type: 'object' } },
    } as never);
    expect(registry.invalidArgs(tool, { operations: '[\n  {"old_str": "a < b"}\n]' })).toBe(
      'Error: apply_line_edits: "operations" must be a JSON array, not a string. ' +
        'Resend the call with operations as [].',
    );
  });

  it('quotes at most 120 characters of a runaway value', () => {
    const message = registry.invalidArgs(readTool, {
      end_line: `9\n</parameter>\n${'x'.repeat(400)}`,
    }) as string;
    const quoted = /It received "([^"]*)"/u.exec(message)?.[1] ?? '';
    // The quote carries the first 120 characters of a 412-character value, then
    // the ellipsis — enough to see the markup and the number, not the flood.
    expect(quoted.endsWith('…')).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(121);
    // The explanation is fixed text; the quote is the only part that grows, so
    // a runaway argument cannot turn the refusal into a wall of text.
    expect(message.length).toBeLessThanOrEqual(500);
  });

  it('is still recorded as a failure by the row, the stats and the ledger', () => {
    const refusal = registry.invalidArgs(readTool, { end_line: '237</parameter>' }) as string;
    expect(refusal).toMatch(/^Error: /u);
    expect(isFailureResult(refusal), refusal).toBe(true);
    expect(classifyResult(refusal), refusal).toBe('failed');
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
