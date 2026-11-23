import { beforeEach, describe, expect, it } from 'vitest';
import {
  isLazyGroupActive,
  recordLazyGroupTool,
  resetLazyToolGroups,
  setSchemasInResult,
  setTextCallCatalog,
} from '../../src/tools/lazyToolGroups';
import { ALL_FORMS } from '../../src/tools/StructuredOutputParser';
import { extractTextCalls } from '../../src/tools/textCallDefinitions';
import { makeLoadToolGroupTool } from '../../src/tools/toolGroupTools';
import { ToolBudget } from '../../src/tools/ToolBudget';
import { ToolRegistry, type ToolPermission } from '../../src/tools/ToolRegistry';
import { buildTextCallDefinitions } from '../../src/sidebar/turnToolDefinitions';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { ModelConfig } from '../../src/config/types';
import type { ToolDefinition } from '../../src/llm/types';

const ALL_PERMISSIONS = new Set<ToolPermission>(['read']);

function def(
  name: string,
  parameters: Record<string, unknown> = { type: 'object' },
  description = '',
): ToolDefinition {
  return { type: 'function', function: { name, description, parameters } };
}

const conv = { id: 'conv-text', compaction: undefined } as unknown as ConversationRuntime;
const flagged: ModelConfig = {
  name: 'm',
  tool_groups: { eager: [], schemas_in_result: true },
} as ModelConfig;
const normal: ModelConfig = { name: 'm', tool_groups: { eager: [] } } as ModelConfig;

/** A registry with one listed tool and one hidden group member whose parameter
 *  is an integer, so typing it is observable. */
function rig(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    definition: def('read_file', { type: 'object', properties: { path: { type: 'string' } } }),
    permission: 'read',
    handler: async () => 'ok',
  });
  registry.register({
    definition: def('count_things', {
      type: 'object',
      properties: { n: { type: 'integer' } },
    }),
    permission: 'read',
    handler: async () => 'ok',
  });
  recordLazyGroupTool('things', 'count_things');
  return registry;
}

const MARKER_CALL =
  '<tool_call>\n<function=count_things>\n<parameter=n>\n3\n</parameter>\n</function>\n</tool_call>';

describe('buildTextCallDefinitions', () => {
  beforeEach(() => resetLazyToolGroups());

  it('holds a registered but unlisted tool after a window reload, with no group activated', () => {
    const registry = rig();
    const defs = buildTextCallDefinitions(
      conv,
      flagged,
      { toolRegistry: registry },
      ALL_PERMISSIONS,
      undefined,
      new ToolBudget(flagged),
    );
    expect(defs.map((d) => d.function.name)).toEqual(['count_things']);
    // Nothing was activated: the activation is gone with the window, and the
    // schemas are still in the transcript, so the call must still be typed.
    expect(isLazyGroupActive('conv-text', 'things')).toBe(false);
    const calls = extractTextCalls(
      MARKER_CALL,
      [def('read_file')],
      ALL_FORMS,
      { getTextCallDefinitions: () => defs },
      ['read_file'],
    );
    expect(calls?.[0]?.function.arguments).toBe('{"n":3}');
  });

  it('stays empty with the flag off, so normal mode is unchanged', () => {
    const registry = rig();
    expect(
      buildTextCallDefinitions(
        conv,
        normal,
        { toolRegistry: registry },
        ALL_PERMISSIONS,
        undefined,
        new ToolBudget(normal),
      ),
    ).toEqual([]);
  });
});

describe('extractTextCalls', () => {
  it('reports the names a round wrote as text, and which were unlisted', () => {
    const seen: Array<[readonly string[], readonly string[]]> = [];
    const calls = extractTextCalls(
      MARKER_CALL,
      [def('read_file'), def('count_things')],
      ALL_FORMS,
      {
        onTextToolCalls: (names, unlisted) => seen.push([names, unlisted]),
      },
      ['read_file'],
    );
    expect(calls).not.toBeNull();
    expect(seen).toEqual([[['count_things'], ['count_things']]]);
  });

  it('reports a listed tool as listed, so the row separates the two causes', () => {
    const seen: Array<[readonly string[], readonly string[]]> = [];
    extractTextCalls(
      MARKER_CALL,
      [def('read_file'), def('count_things')],
      ALL_FORMS,
      { onTextToolCalls: (names, unlisted) => seen.push([names, unlisted]) },
      ['read_file', 'count_things'],
    );
    expect(seen).toEqual([[['count_things'], []]]);
  });

  it('reports nothing when the text held no call', () => {
    let calls = 0;
    const result = extractTextCalls('Just an answer.', [], ALL_FORMS, {
      onTextToolCalls: () => {
        calls += 1;
      },
    }, []);
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('load_tool_group with schemas_in_result', () => {
  const CTX = { beforeMutate: () => undefined, conversationId: 'conv-load' };

  /** A two-member group where the turn's catalog holds only one of them. */
  function notebookRig(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      definition: def(
        'read_notebook',
        {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        'Read a notebook.',
      ),
      permission: 'read',
      handler: async () => 'ok',
    });
    registry.register({
      definition: def('edit_notebook_cell', { type: 'object' }, 'Edit a cell.'),
      permission: 'read',
      handler: async () => 'ok',
    });
    for (const name of ['read_notebook', 'edit_notebook_cell']) recordLazyGroupTool('notebook', name);
    registry.register(makeLoadToolGroupTool());
    return registry;
  }

  const RESULT = [
    'notebook tools enabled for this conversation: read_notebook. They are not added ' +
      'to your tool list; call them like your other tools, with these schemas:',
    '{"name":"read_notebook","description":"Read a notebook.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}',
    'Not allowed in this chat, so not listed: edit_notebook_cell.',
  ].join('\n');

  it('returns the group schemas and names the member the chat may not call', async () => {
    const registry = notebookRig();
    setSchemasInResult('conv-load', true);
    setTextCallCatalog('conv-load', [
      def(
        'read_notebook',
        {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        'Read a notebook.',
      ),
    ]);
    const result = await registry.dispatch('load_tool_group', { group: 'notebook' }, ALL_PERMISSIONS, CTX);
    expect(result).toBe(RESULT);
  });

  it('returns the same text on a repeat call — the recovery path after excerpting', async () => {
    const registry = notebookRig();
    setSchemasInResult('conv-load', true);
    const catalog = [
      def(
        'read_notebook',
        {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        'Read a notebook.',
      ),
    ];
    setTextCallCatalog('conv-load', catalog);
    const first = await registry.dispatch('load_tool_group', { group: 'notebook' }, ALL_PERMISSIONS, CTX);
    const second = await registry.dispatch('load_tool_group', { group: 'notebook' }, ALL_PERMISSIONS, CTX);
    expect(first).toBe(RESULT);
    expect(second).toBe(first);
  });
});
