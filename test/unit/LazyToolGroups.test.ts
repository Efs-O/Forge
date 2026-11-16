import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateLazyGroup,
  deactivateLazyGroups,
  hiddenLazyToolNames,
  isLazyGroupActive,
  isLazyGroupAvailable,
  lazyGroupForTool,
  lazyGroupNames,
  lazyGroupForServer,
  recordNativeLazyTool,
  recordLazyGroupTool,
  resetLazyToolGroups,
} from '../../src/tools/lazyToolGroups';
import { makeLoadToolGroupTool } from '../../src/tools/toolGroupTools';
import { mcpToolToRegisteredTool } from '../../src/tools/mcpBridge';
import { forgeMcpToolName } from '../../src/tools/mcpProviderContract';
import { ToolRegistry, type ToolPermission } from '../../src/tools/ToolRegistry';
import { ToolBudget } from '../../src/tools/ToolBudget';

const ALL_PERMISSIONS = new Set<ToolPermission>(['read']);

const HALLUSCRIBE_TOOLS = [
  'search_sessions',
  'search_raw_transcripts',
  'read_session',
  'read_raw_session',
  'get_profile',
  'get_digest',
];

/** Two bridged tools, used both as an eager control and as a demand-loaded server. */
const OTHER_MCP_TOOLS = ['fetch_page', 'list_repos'];

/**
 * The model-facing list, composed exactly as `ModelTurn.buildToolDefinitions`
 * composes it: everything the registry advertises, minus the lazy tools this
 * conversation has not activated.
 */
function modelFacingTools(registry: ToolRegistry, conversationId: string | undefined): string[] {
  const hidden = hiddenLazyToolNames(conversationId);
  return registry
    .definitions(ALL_PERMISSIONS)
    .map((definition) => definition.function.name)
    .filter((name) => !hidden.has(name));
}

/** Bridges a server's tools in the same order and shape mcpBridge does. */
function bridge(
  registry: ToolRegistry,
  serverName: string,
  toolNames: string[],
  eager = false,
): void {
  const group = lazyGroupForServer(serverName, eager);
  for (const name of toolNames) {
    registry.register(
      mcpToolToRegisteredTool(
        serverName,
        forgeMcpToolName(name),
        { name, inputSchema: { type: 'object' } },
        async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      ),
    );
    if (group) recordLazyGroupTool(group, name);
  }
}

function registryWithHalluscribe(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(makeLoadToolGroupTool());
  bridge(registry, 'halluscribe', HALLUSCRIBE_TOOLS);
  bridge(registry, 'other-server', OTHER_MCP_TOOLS, true);
  return registry;
}

describe('lazy tool groups', () => {
  beforeEach(() => resetLazyToolGroups());

  it('withholds media until the conversation loads it, and offers files/background on the first request', () => {
    const registry = new ToolRegistry();
    const names = [
      'view_image',
      'view_video',
      'generate_image',
      'image_search',
      'send_file',
      'render_html_to_image',
      'export_document',
      'move_file',
      'apply_line_edits',
      'restore_file',
      'stop_execution',
      'list_executions',
      'wait',
    ];
    for (const name of names) {
      registry.register({
        definition: {
          type: 'function',
          function: {
            name,
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
        permission: 'read',
        handler: async () => 'ok',
      });
      recordNativeLazyTool(name);
    }

    const firstRequest = modelFacingTools(registry, 'fresh-conversation');
    expect(firstRequest).toEqual(
      expect.arrayContaining([
        'move_file',
        'apply_line_edits',
        'restore_file',
        'stop_execution',
        'list_executions',
        'wait',
      ]),
    );
    // `media` left the eager-by-default set on 2026-10-29: across the 53
    // sessions since 0.17.80 `view_video`, `image_search`, `upscale_image` and
    // `render_html_to_image` had 0 calls and `generate_image` 1, and the
    // group's only use (view_image 94, send_file 52) came from one session.
    for (const name of [
      'view_image',
      'view_video',
      'generate_image',
      'image_search',
      'send_file',
      'render_html_to_image',
    ])
      expect(firstRequest).not.toContain(name);
    activateLazyGroup('fresh-conversation', 'media');
    const afterLoad = modelFacingTools(registry, 'fresh-conversation');
    for (const name of [
      'view_image',
      'view_video',
      'generate_image',
      'image_search',
      'send_file',
      'render_html_to_image',
    ])
      expect(afterLoad).toContain(name);
    // The owner's escape hatch stays: `tool_groups.eager: [media]` advertises
    // the whole group from the first round without touching the active map.
    const eagerMedia = hiddenLazyToolNames('other-conversation', new Set(), new Set(['media']));
    for (const name of [
      'view_image',
      'view_video',
      'generate_image',
      'image_search',
      'send_file',
      'render_html_to_image',
    ])
      expect(eagerMedia).not.toContain(name);
  });

  // git_read moved into the lazy `git` group on 2026-10-29: 6 calls against 418
  // shell git commands across the 53 sessions since 0.17.80, so the schema is
  // not what the model reaches for when it wants git.
  it('withholds git_read until the git group loads, and still dispatches it while hidden', async () => {
    const registry = new ToolRegistry();
    registry.register(makeLoadToolGroupTool());
    for (const name of ['git_read', 'stage', 'commit', 'create_branch', 'switch_branch']) {
      registry.register({
        definition: {
          type: 'function',
          function: { name, description: '', parameters: { type: 'object' } },
        },
        permission: 'read',
        handler: async () => `${name} ran`,
      });
      recordNativeLazyTool(name);
    }
    expect(lazyGroupForTool('git_read')).toBe('git');
    expect(hiddenLazyToolNames('conv-a')).toContain('git_read');
    expect(modelFacingTools(registry, 'conv-a')).not.toContain('git_read');
    // The registered-but-unadvertised rule is unchanged: a model that calls a
    // hidden tool by name still gets it run, not an unknown-tool error.
    expect(
      await registry.dispatch('git_read', { operation: 'status' }, ALL_PERMISSIONS, {
        beforeMutate: () => undefined,
        conversationId: 'conv-a',
      }),
    ).toBe('git_read ran');
    activateLazyGroup('conv-a', 'git');
    expect(hiddenLazyToolNames('conv-a')).not.toContain('git_read');
    expect(modelFacingTools(registry, 'conv-a')).toContain('git_read');
    // The purpose line carries the read verbs, and the member list names the
    // exact tool that triggered this group lookup.
    expect(registry.get('load_tool_group')?.describe?.().function.description).toMatch(
      /git: [^\n]*(status|log|diff|blame|show)[^\n]*stage, commit[^\n]*shell runs git too/,
    );
  });

  it('withholds every halluscribe schema from a fresh conversation but advertises the loader', () => {
    const tools = modelFacingTools(registryWithHalluscribe(), 'conv-a');
    for (const name of HALLUSCRIBE_TOOLS) expect(tools).not.toContain(name);
    expect(tools).toContain('load_tool_group');
  });

  it('exposes the six real schemas on the next request after activation', async () => {
    const registry = registryWithHalluscribe();
    const result = await registry.dispatch(
      'load_tool_group',
      { group: 'halluscribe' },
      ALL_PERMISSIONS,
      {
        beforeMutate: () => undefined,
        conversationId: 'conv-a',
      },
    );

    expect(result).toContain('enabled');
    // The result names the members but must not restate the schemas -- they
    // arrive via `tools`.
    for (const name of HALLUSCRIBE_TOOLS) expect(result).toContain(name);
    expect(result).not.toMatch(/"type"|parameters|properties/u);

    const tools = modelFacingTools(registry, 'conv-a');
    for (const name of HALLUSCRIBE_TOOLS) expect(tools).toContain(name);
  });

  it('keeps the group loaded for later rounds without a second activation call', () => {
    const registry = registryWithHalluscribe();
    activateLazyGroup('conv-a', 'halluscribe');
    for (let round = 0; round < 3; round++) {
      expect(modelFacingTools(registry, 'conv-a')).toContain('search_sessions');
    }
  });

  it('does not leak activation into another conversation', () => {
    const registry = registryWithHalluscribe();
    activateLazyGroup('conv-a', 'halluscribe');
    expect(modelFacingTools(registry, 'conv-b')).not.toContain('search_sessions');
    expect(isLazyGroupActive('conv-b', 'halluscribe')).toBe(false);
    // ...and the conversation that did activate is unaffected by the other.
    expect(modelFacingTools(registry, 'conv-a')).toContain('search_sessions');
  });

  it('fails honestly and stays unloaded when halluscribe is not connected', async () => {
    const registry = new ToolRegistry();
    registry.register(makeLoadToolGroupTool());

    expect(isLazyGroupAvailable('halluscribe')).toBe(false);
    // Not advertised at all when there is nothing to load.
    expect(modelFacingTools(registry, 'conv-a')).not.toContain('load_tool_group');

    await expect(
      registry.dispatch('load_tool_group', { group: 'halluscribe' }, ALL_PERMISSIONS, {
        beforeMutate: () => undefined,
        conversationId: 'conv-a',
      }),
    ).rejects.toThrow(
      /unavailable because its MCP server is not configured or failed to connect; do not retry\. Answer from the workspace and the conversation instead\./,
    );

    expect(isLazyGroupActive('conv-a', 'halluscribe')).toBe(false);
    expect(modelFacingTools(registry, 'conv-a')).toEqual([]);
  });

  it('holds an ordinary MCP server behind its own group, and advertises one that asks to stay eager', () => {
    // The default flipped on 2026-11-14: a bridged server now waits behind
    // `load_tool_group` under a group named after it, so a conversation that
    // never touches it stops paying its schemas every turn. `eager: true` on the
    // server entry keeps the old behaviour for a server used every turn.
    expect(lazyGroupForServer('other-server')).toBe('other-server');
    expect(lazyGroupForServer('other-server', true)).toBeUndefined();

    const lazy = new ToolRegistry();
    lazy.register(makeLoadToolGroupTool());
    bridge(lazy, 'quiet-server', OTHER_MCP_TOOLS);
    expect(modelFacingTools(lazy, 'conv-a')).not.toContain('fetch_page');
    expect(lazyGroupNames()).toContain('quiet-server');
    activateLazyGroup('conv-a', 'quiet-server');
    expect(modelFacingTools(lazy, 'conv-a')).toContain('fetch_page');
    expect(modelFacingTools(lazy, 'conv-b')).not.toContain('fetch_page');

    const eager = registryWithHalluscribe();
    for (const name of OTHER_MCP_TOOLS) {
      expect(modelFacingTools(eager, 'conv-a')).toContain(name);
    }
    activateLazyGroup('conv-a', 'halluscribe');
    for (const name of OTHER_MCP_TOOLS) {
      expect(modelFacingTools(eager, 'conv-a')).toContain(name);
    }
  });

  it('refuses an MCP server that claims a built-in group name, and gives it its own', () => {
    // A server configured as `files` used to merge into the native `files`
    // group. That group is advertised on every request, so the server's tools
    // arrived unasked in every conversation and disappeared again with the
    // native ones when it was hidden.
    expect(lazyGroupForServer('files')).toBe('mcp-files');
    expect(lazyGroupForServer('Files')).toBe('mcp-Files'); // matched case-insensitively
    expect(lazyGroupForServer('background')).toBe('mcp-background');
    expect(lazyGroupForServer('git')).toBe('mcp-git');
    expect(lazyGroupForServer('files', true)).toBeUndefined();
    // A name nothing else uses is returned untouched, exactly as before.
    expect(lazyGroupForServer('github')).toBe('github');

    const registry = new ToolRegistry();
    registry.register(makeLoadToolGroupTool());
    recordNativeLazyTool('move_file'); // so the native `files` group has a member
    bridge(registry, 'files', OTHER_MCP_TOOLS);
    // Two separate groups, and the name the model is told is the one that works.
    expect(lazyGroupNames()).toEqual(expect.arrayContaining(['files', 'mcp-files']));
    expect(modelFacingTools(registry, 'conv-a')).not.toContain('fetch_page');
    // The native group being active (it is always advertised) does not reveal them.
    activateLazyGroup('conv-a', 'files');
    expect(modelFacingTools(registry, 'conv-a')).not.toContain('fetch_page');
    activateLazyGroup('conv-a', 'mcp-files');
    expect(modelFacingTools(registry, 'conv-a')).toContain('fetch_page');
    expect(modelFacingTools(registry, 'conv-b')).not.toContain('fetch_page');
  });

  it('registers the rare native and MCP groups with their tool families', () => {
    const registry = new ToolRegistry();
    registry.register(makeLoadToolGroupTool());
    for (const name of [
      'desktop_capture',
      'view_image',
      'send_file',
      'render_html_to_image',
      'get_editor_context',
      'get_power_info',
      'remember',
      'read_notebook',
      'ask_agent',
      'ask_user',
      'notify_user',
      'get_system_status',
    ]) {
      registry.register({
        definition: {
          type: 'function',
          function: { name, description: '', parameters: { type: 'object' } },
        },
        permission: 'read',
        handler: async () => 'ok',
      });
      recordNativeLazyTool(name);
    }
    bridge(registry, 'halluscribe', HALLUSCRIBE_TOOLS);

    expect(lazyGroupNames()).toEqual([
      'agents',
      'computer_use',
      'editor_ui',
      'halluscribe',
      'media',
      'memory',
      'notebook',
      'system',
    ]);
    expect([
      lazyGroupForTool('desktop_capture'),
      lazyGroupForTool('view_image'),
      lazyGroupForTool('send_file'),
      lazyGroupForTool('get_editor_context'),
      lazyGroupForTool('get_power_info'),
      lazyGroupForTool('remember'),
      lazyGroupForTool('recall'),
      lazyGroupForTool('list_memories'),
      lazyGroupForTool('forget'),
      lazyGroupForTool('read_notebook'),
      lazyGroupForTool('search_sessions'),
    ]).toEqual([
      'computer_use',
      'media',
      'media',
      'editor_ui',
      'system',
      'memory',
      'memory',
      'memory',
      'memory',
      'notebook',
      'halluscribe',
    ]);
    for (const name of [
      'ask_agent',
      'manage_jobs',
      'notify_user',
      'ask_local_agent',
      'list_delegation_targets',
    ]) {
      expect(lazyGroupForTool(name)).toBe('agents');
    }
    expect(hiddenLazyToolNames('conv-a')).toContain('ask_agent');
    expect(hiddenLazyToolNames('conv-a')).toContain('notify_user');
    expect(hiddenLazyToolNames('conv-a')).not.toContain('manage_jobs');
    expect(lazyGroupForTool('ask_user')).toBeUndefined();
    expect(hiddenLazyToolNames('conv-a')).not.toContain('ask_user');
    expect(lazyGroupForTool('get_system_status')).toBe('system');
    expect(hiddenLazyToolNames('conv-a')).toContain('get_system_status');
    // `media` is lazy since 2026-10-29; `computer_use` stays a normal lazy
    // group. `render_html_to_image` joined `media` the same day, so a
    // conversation that never renders or reviews an image pays none of its
    // 3,905-char schema (it was ungrouped and always advertised).
    expect(lazyGroupForTool('render_html_to_image')).toBe('media');
    expect(lazyGroupForTool('export_document')).toBe('media');
    recordNativeLazyTool('export_document');
    expect(hiddenLazyToolNames('conv-a')).toContain('send_file');
    expect(hiddenLazyToolNames('conv-a')).toContain('render_html_to_image');
    expect(hiddenLazyToolNames('conv-a')).toContain('export_document');
    activateLazyGroup('conv-a', 'media');
    expect(hiddenLazyToolNames('conv-a')).not.toContain('send_file');
    expect(hiddenLazyToolNames('conv-a')).not.toContain('render_html_to_image');
    expect(hiddenLazyToolNames('conv-a')).not.toContain('export_document');
    deactivateLazyGroups('conv-a');
    const loader = registry
      .definitions(ALL_PERMISSIONS)
      .find((d) => d.function.name === 'load_tool_group');
    expect(loader?.function.parameters).toMatchObject({
      properties: { group: { enum: lazyGroupNames() } },
    });
    expect(loader?.function.parameters).toMatchObject({
      properties: { group: { enum: expect.arrayContaining(['memory', 'agents']) } },
    });
    expect(loader?.function.description).toContain(
      'memory: remember, recall, forget notes kept across conversations (remember)\n',
    );
    expect(loader?.function.description).toContain(
      'system: this PC: power, sleep/wake, status (get_power_info, get_system_status)',
    );
    // The media line carries searchable verbs and the exact registered names.
    expect(loader?.function.description).toMatch(
      /media: [^\n]*(upscale|render|video|image search)[^\n]*send files/,
    );
    expect(loader?.function.description).toContain('get_power_info');
    expect(loader?.function.description.split(/\s+/).length).toBeLessThanOrEqual(350);
    const staticDefinition = makeLoadToolGroupTool().definition;
    expect(staticDefinition.function.parameters).toMatchObject({
      properties: { group: { type: 'string' } },
    });
    expect(
      (staticDefinition.function.parameters.properties as Record<string, { enum?: unknown[] }>)
        .group.enum,
    ).toBeUndefined();
  });

  it('loads computer_use on a non-vision model', async () => {
    const registry = new ToolRegistry();
    registry.register(makeLoadToolGroupTool());
    registry.register({
      definition: {
        type: 'function',
        function: { name: 'desktop_capture', description: '', parameters: { type: 'object' } },
      },
      permission: 'read',
      handler: async () => 'should not run',
    });
    const result = await registry.dispatch(
      'load_tool_group',
      { group: 'computer_use' },
      ALL_PERMISSIONS,
      {
        beforeMutate: () => undefined,
        conversationId: 'conv-a',
        modelName: 'qwen38-no-vision',
        isVisionModel: false,
      },
    );
    expect(result).toContain('enabled');
    expect(isLazyGroupActive('conv-a', 'computer_use')).toBe(true);
    expect(hiddenLazyToolNames('conv-a')).not.toContain('desktop_capture');
  });

  it('eagerly advertises a configured group without adding it to the active group map', () => {
    const registry = new ToolRegistry();
    const memoryTools = ['remember', 'recall', 'list_memories', 'forget'];
    for (const name of memoryTools) {
      registry.register({
        definition: {
          type: 'function',
          function: { name, description: '', parameters: { type: 'object' } },
        },
        permission: 'read',
        handler: async () => 'ok',
      });
      recordNativeLazyTool(name);
    }
    const budget = new ToolBudget({ tools: memoryTools });
    const hidden = hiddenLazyToolNames('conv-a', new Set(), new Set(['memory']));
    const advertised = budget.filterDefinitions(
      registry.definitions(ALL_PERMISSIONS).filter((d) => !hidden.has(d.function.name)),
    );
    expect(advertised.map((definition) => definition.function.name)).toEqual(memoryTools);
    expect(memoryTools.map((name) => lazyGroupForTool(name))).toEqual([
      'memory',
      'memory',
      'memory',
      'memory',
    ]);
    expect(isLazyGroupActive('conv-a', 'memory')).toBe(false);
    deactivateLazyGroups('conv-a');
    expect(isLazyGroupActive('conv-a', 'memory')).toBe(false);
    expect(hiddenLazyToolNames('conv-a', new Set(), new Set(['memory']))).toEqual(new Set());
  });

  it('appends the loaded schemas after the existing prefix, leaving it byte-identical', () => {
    const registry = registryWithHalluscribe();
    const before = modelFacingTools(registry, 'conv-a');
    activateLazyGroup('conv-a', 'halluscribe');
    const after = modelFacingTools(registry, 'conv-a');
    // Not merely a superset: the shared prefix must not move, or every request
    // after activation re-prefills tools the KV cache already held.
    expect(after.slice(0, before.length - OTHER_MCP_TOOLS.length)).toEqual(
      before.slice(0, before.length - OTHER_MCP_TOOLS.length),
    );
    expect(after).toHaveLength(before.length + HALLUSCRIBE_TOOLS.length);
  });
});
