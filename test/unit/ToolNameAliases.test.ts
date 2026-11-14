// Phase 7 of the streamline plan: a model that speaks another agent's dialect
// gets the tool that does the job, instead of an `unknown tool` refusal and a
// prompt line teaching the same lesson again.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { preflightToolCall } from '../../src/sidebar/toolCallPreflight';
import type { ToolBudget } from '../../src/tools/ToolBudget';
import type { RegisteredTool, ToolPermission } from '../../src/tools/ToolRegistry';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import {
  TOOL_NAME_ALIASES,
  aliasUsageFile,
  applyToolNameAlias,
  canonicalToolName,
  readAliasUsage,
  recordToolNameAliasHit,
} from '../../src/tools/toolNameAliases';
// @ts-expect-error -- the standalone catalog is a plain ESM script
import { extractToolAuditSnapshot } from '../../scripts/tool-audit-catalog.mjs';

vi.mock('vscode', () => {
  const p = require('path') as typeof import('path');
  const o = require('os') as typeof import('os');
  const workspace = p.join(o.tmpdir(), 'forge-tool-alias-workspace');
  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
      asRelativePath: vi.fn((value: string) => value),
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        clear: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn(),
      })),
    },
    Uri: { file: vi.fn((fsPath: string) => ({ fsPath })) },
  };
});

const allowed = new Set<ToolPermission>(['read', 'fetch']);

function call(name: string): ToolCall {
  return { id: 'call-alias', type: 'function', function: { name, arguments: '{}' } };
}

function tool(name: string, handler = vi.fn(async () => 'called')): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object' } },
    },
    permission: 'read',
    handler,
  };
}

function createDispatch(registry: ToolRegistry): ToolDispatch {
  return new ToolDispatch(
    registry,
    {} as CheckpointStack,
    {} as KeepUndoCodeLensProvider,
    { record: vi.fn(), reset: vi.fn() } as unknown as ToolFailureTracker,
    vi.fn(),
    vi.fn(async () => 'approved' as const),
    {} as DiffDecorations,
  );
}

let usageFile: string;
let temp: string;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tool-alias-'));
  usageFile = path.join(temp, 'tool-aliases.jsonl');
  process.env.FORGE_TOOL_ALIAS_FILE = usageFile;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.FORGE_TOOL_ALIAS_FILE;
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('the alias table', () => {
  it('answers every foreign name with one live tool, and never shadows a real name', async () => {
    const snapshot = await extractToolAuditSnapshot();
    const live = new Set<string>(snapshot.names as string[]);
    expect(Object.keys(TOOL_NAME_ALIASES).length).toBeGreaterThanOrEqual(8);
    for (const [alias, target] of Object.entries(TOOL_NAME_ALIASES)) {
      expect(live.has(alias), `"${alias}" is itself a live tool name`).toBe(false);
      expect(live.has(target), `"${alias}" points at "${target}", which is not a live tool`).toBe(
        true,
      );
    }
    // 20 s: the catalog parses the whole source tree; the 5 s default expired
    // under full-suite load (the same gate ToolHarness.test.ts records).
  }, 20_000);

  it('matches the exact name only — no case folding, no prefix, no fuzzy', () => {
    expect(canonicalToolName('bash')).toBe('shell');
    expect(canonicalToolName('search_code')).toBe('grep_search');
    for (const near of ['Bash', 'BASH', 'bashx', 'grep_code', 'apply_patch', 'LS', 'ls ']) {
      expect(canonicalToolName(near), near).toBeUndefined();
    }
  });

  it('rewrites the call in place, once: a second pass sees the canonical name', () => {
    const tc = call('bash');
    expect(applyToolNameAlias(tc)).toEqual({ alias: 'bash', tool: 'shell' });
    expect(tc.function.name).toBe('shell');
    expect(applyToolNameAlias(tc)).toBeUndefined();
  });

  it('adds no advertised characters: no alias is a tool, so none is in the catalog', async () => {
    const snapshot = await extractToolAuditSnapshot();
    const names = new Set<string>(snapshot.names as string[]);
    for (const alias of Object.keys(TOOL_NAME_ALIASES)) {
      expect(names.has(alias), `"${alias}" became an advertised tool`).toBe(false);
    }
    expect(names.has('grep_search')).toBe(true);
    // 20 s: same catalog call as the test above.
  }, 20_000);
});

describe('the usage counter', () => {
  it('counts every alias per name, in a file the next session can read', () => {
    recordToolNameAliasHit(
      { alias: 'ls', tool: 'list_directory' },
      'conv-12345678-abcd',
      usageFile,
    );
    recordToolNameAliasHit({ alias: 'ls', tool: 'list_directory' }, undefined, usageFile);
    recordToolNameAliasHit({ alias: 'bash', tool: 'shell' }, undefined, usageFile);
    expect(readAliasUsage(usageFile)).toEqual({ ls: 2, bash: 1 });
    const rows = fs
      .readFileSync(usageFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows[0]).toMatchObject({ alias: 'ls', tool: 'list_directory', conv: 'conv-123' });
    expect(typeof rows[0]?.['ts']).toBe('string');
  });

  it("survives an unwritable counter: the model's call is not refused for a lost count", () => {
    const blocker = path.join(temp, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    expect(() =>
      recordToolNameAliasHit(
        { alias: 'bash', tool: 'shell' },
        undefined,
        path.join(blocker, 'deeper', 'a.jsonl'),
      ),
    ).not.toThrow();
    expect(readAliasUsage(path.join(temp, 'absent.jsonl'))).toEqual({});
  });

  it('defaults to ~/.forge/telemetry when nothing overrides it', () => {
    delete process.env.FORGE_TOOL_ALIAS_FILE;
    expect(aliasUsageFile()).toContain(path.join('.forge', 'telemetry', 'tool-aliases.jsonl'));
  });
});

describe('a call that names another dialect', () => {
  async function dispatchNamed(name: string, registry: ToolRegistry): Promise<string> {
    const messages: ChatMessage[] = [];
    await createDispatch(registry).dispatch(
      [call(name)],
      allowed,
      messages,
      'conv-alias',
      undefined,
      undefined,
      undefined as ToolBudget | undefined,
    );
    return String(messages[0]?.content ?? '');
  }

  it('runs the real tool for `bash`, and counts the hit', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'ran shell');
    registry.register(tool('shell', handler));
    expect(await dispatchNamed('bash', registry)).toContain('ran shell');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(readAliasUsage(usageFile)).toEqual({ bash: 1 });
  });

  it('runs grep_search for the old name `search_code`, and counts it', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'ran grep_search');
    registry.register(tool('grep_search', handler));
    expect(await dispatchNamed('search_code', registry)).toContain('ran grep_search');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(readAliasUsage(usageFile)).toEqual({ search_code: 1 });
  });

  it('refuses a name that is not a tool and not an alias, without guessing', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('grep_search'));
    expect(await dispatchNamed('grep_the_files', registry)).toContain('unknown tool');
    expect(readAliasUsage(usageFile)).toEqual({});
  });

  it('asks approval for the tool it resolved, not for the name typed', () => {
    const registry = new ToolRegistry();
    registry.register(tool('write_file'));
    const pre = preflightToolCall(call('create_file'), {
      toolRegistry: registry,
      allowed,
      convId: 'conv-alias',
      signal: undefined,
      budget: undefined,
      unavailableTools: undefined,
      clankerMode: false,
    });
    expect(pre.kind).not.toBe('refused');
    if (pre.kind !== 'refused') {
      expect(pre.reg.definition.function.name).toBe('write_file');
    }
    expect(readAliasUsage(usageFile)).toEqual({ create_file: 1 });
  });
});
