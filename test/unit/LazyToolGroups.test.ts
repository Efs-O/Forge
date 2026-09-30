import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateLazyGroup,
  hiddenLazyToolNames,
  isLazyGroupActive,
  isLazyGroupAvailable,
  lazyGroupForTool,
  lazyGroupNames,
  lazyGroupForServer,
  recordLazyGroupTool,
  resetLazyToolGroups,
} from '../../src/tools/lazyToolGroups';
import { makeLoadToolGroupTool } from '../../src/tools/toolGroupTools';
import { mcpToolToRegisteredTool } from '../../src/tools/mcpBridge';
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

/** Two bridged tools from a server that is NOT lazy, as a control group. */
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
function bridge(registry: ToolRegistry, serverName: string, toolNames: string[]): void {
  const group = lazyGroupForServer(serverName);
  for (const name of toolNames) {
    registry.register(
      mcpToolToRegisteredTool(serverName, { name, inputSchema: { type: 'object' } }, async () => ({
        content: [{ type: 'text', text: 'ok' }],
      })),
    );
    if (group) recordLazyGroupTool(group, name);
  }
}

function registryWithHalluscribe(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(makeLoadToolGroupTool());
  bridge(registry, 'halluscribe', HALLUSCRIBE_TOOLS);
  bridge(registry, 'other-server', OTHER_MCP_TOOLS);
  return registry;
}

describe('lazy tool groups', () => {
  beforeEach(() => resetLazyToolGroups());

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
    // The result must not restate the schemas -- they arrive via `tools`.
    for (const name of HALLUSCRIBE_TOOLS) expect(result).not.toContain(name);

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

  it('leaves other MCP servers advertised in both states', () => {
    const registry = registryWithHalluscribe();
    expect(lazyGroupForServer('other-server')).toBeUndefined();
    for (const name of OTHER_MCP_TOOLS) {
      expect(modelFacingTools(registry, 'conv-a')).toContain(name);
    }
    activateLazyGroup('conv-a', 'halluscribe');
    for (const name of OTHER_MCP_TOOLS) {
      expect(modelFacingTools(registry, 'conv-a')).toContain(name);
    }
  });

  it('registers the rare native and MCP groups with their tool families', () => {
    const registry = new ToolRegistry();
    registry.register(makeLoadToolGroupTool());
    for (const name of [
      'desktop_capture', 'view_image', 'get_editor_context', 'install_llamacpp',
      'get_power_info', 'remember', 'read_notebook', 'ask_live_session', 'ask_user',
      'notify_user', 'get_system_status',
    ]) {
      registry.register({
        definition: { type: 'function', function: { name, description: '', parameters: { type: 'object' } } },
        permission: 'read',
        handler: async () => 'ok',
      });
    }
    bridge(registry, 'halluscribe', HALLUSCRIBE_TOOLS);

    expect(lazyGroupNames()).toEqual([
      'computer_use', 'editor_ui', 'halluscribe', 'media', 'memory', 'notebook', 'system',
    ]);
    expect([
      lazyGroupForTool('desktop_capture'), lazyGroupForTool('view_image'),
      lazyGroupForTool('get_editor_context'), lazyGroupForTool('install_llamacpp'),
      lazyGroupForTool('get_power_info'), lazyGroupForTool('remember'),
      lazyGroupForTool('read_notebook'), lazyGroupForTool('search_sessions'),
    ]).toEqual([
      'computer_use', 'media', 'editor_ui', 'system', 'system', 'memory', 'notebook', 'halluscribe',
    ]);
    for (const name of [
      'ask_live_session', 'manage_jobs', 'notify_user', 'ask_local_agent',
      'ask_user', 'tell_live_session', 'list_delegation_targets', 'get_system_status',
    ]) {
      expect(lazyGroupForTool(name)).toBeUndefined();
      expect(hiddenLazyToolNames('conv-a')).not.toContain(name);
    }
    const loader = registry.definitions(ALL_PERMISSIONS).find((d) => d.function.name === 'load_tool_group');
    expect(loader?.function.parameters).toMatchObject({
      properties: { group: { enum: lazyGroupNames() } },
    });
    expect(loader?.function.description).toContain('computer_use: control browser tabs and the desktop; tools: desktop_capture');
    expect(loader?.function.description).toContain('system: install llama.cpp and inspect or control computer power; tools: get_power_info');
    expect(loader?.function.description).toContain('search previous AI coding sessions and historical workspace/user context');
    expect(loader?.function.description.split(/\s+/).length).toBeLessThanOrEqual(350);
    const staticDefinition = makeLoadToolGroupTool().definition;
    expect(staticDefinition.function.parameters).toMatchObject({
      properties: { group: { type: 'string' } },
    });
    expect((staticDefinition.function.parameters.properties as Record<string, { enum?: unknown[] }>).group.enum).toBeUndefined();
  });

  it('refuses computer_use on a non-vision model and names that model', async () => {
    const registry = new ToolRegistry();
    registry.register(makeLoadToolGroupTool());
    registry.register({
      definition: { type: 'function', function: { name: 'desktop_capture', description: '', parameters: { type: 'object' } } },
      permission: 'read',
      handler: async () => 'should not run',
    });
    activateLazyGroup('conv-a', 'computer_use');

    await expect(registry.dispatch('load_tool_group', { group: 'computer_use' }, ALL_PERMISSIONS, {
      beforeMutate: () => undefined,
      conversationId: 'conv-a',
      modelName: 'qwen38-no-vision',
      isVisionModel: false,
    })).rejects.toThrow('computer_use is unavailable on non-vision model "qwen38-no-vision"; do not retry. Answer from the workspace and the conversation instead.');
    expect(isLazyGroupActive('conv-a', 'computer_use')).toBe(true);
    expect(hiddenLazyToolNames('conv-a', new Set(['desktop_capture']), false)).toContain('desktop_capture');
  });

  it('eagerly advertises configured native tools from the lazy groups', () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: { type: 'function', function: { name: 'remember', description: '', parameters: { type: 'object' } } },
      permission: 'read',
      handler: async () => 'ok',
    });
    const budget = new ToolBudget({ tools: ['remember'] });
    const hidden = hiddenLazyToolNames('conv-a', new Set(['remember']));
    const advertised = budget.filterDefinitions(
      registry.definitions(ALL_PERMISSIONS).filter((d) => !hidden.has(d.function.name)),
    );
    expect(advertised.map((definition) => definition.function.name)).toContain('remember');
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
