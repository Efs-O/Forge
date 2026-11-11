import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import { ToolBudget } from '../../src/tools/ToolBudget';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { RETIRED_TOOLS } from '../../src/sidebar/retiredTools';
import {
  hasAvailableLazyGroup,
  resetLazyToolGroups,
  activateLazyGroup,
} from '../../src/tools/lazyToolGroups';
import type { RegisteredTool, ToolPermission } from '../../src/tools/ToolRegistry';
import type { ToolFailureTracker } from '../../src/tools/StripTools';

vi.mock('vscode', () => {
  const p = require('path') as typeof import('path');
  const o = require('os') as typeof import('os');
  const workspace = p.join(o.tmpdir(), 'forge-tool-dispatch-hint-workspace');
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
  return {
    id: 'call-unknown',
    type: 'function',
    function: { name, arguments: '{}' },
  };
}

function tool(
  name: string,
  options: Partial<Pick<RegisteredTool, 'permission' | 'advertise' | 'requiresVision'>> = {},
  handler = vi.fn(async () => 'called'),
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object' } },
    },
    permission: options.permission ?? 'read',
    ...(options.advertise ? { advertise: options.advertise } : {}),
    ...(options.requiresVision ? { requiresVision: options.requiresVision } : {}),
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

// generate_image stands in for any tool hidden in a lazy group: it is in
// media. (render_html_to_image was the example until it went eager.)
function registerMedia(registry: ToolRegistry, imageHandler = vi.fn(async () => 'image')): void {
  registry.register(tool('generate_image', {}, imageHandler));
  registry.register(tool('load_tool_group', { advertise: hasAvailableLazyGroup }));
}

async function dispatchUnknown(options: {
  name: string;
  registry: ToolRegistry;
  convId?: string;
  budget?: ToolBudget;
  isVisionModel?: boolean;
  unavailableTools?: ReadonlyMap<string, string>;
  allowed?: Set<ToolPermission>;
}): Promise<string> {
  const messages: ChatMessage[] = [];
  await createDispatch(options.registry).dispatch(
    [call(options.name)],
    options.allowed ?? allowed,
    messages,
    options.convId ?? 'conv-a',
    undefined,
    undefined,
    options.budget,
    undefined,
    options.unavailableTools,
    undefined,
    undefined,
    {
      modelName: 'test-model',
      isVisionModel: options.isVisionModel ?? true,
    },
  );
  return String(messages[0]?.content ?? '');
}

describe('unknown tool name hints', () => {
  beforeEach(() => resetLazyToolGroups());

  afterEach(() => {
    vi.clearAllMocks();
    resetLazyToolGroups();
  });

  it('names the current replacement for every known retired tool name', async () => {
    const registry = new ToolRegistry();
    const replacements = new Set(Object.values(RETIRED_TOOLS).map(({ tool: name }) => name));
    for (const name of replacements) registry.register(tool(name));
    registry.register(tool('load_tool_group', { advertise: hasAvailableLazyGroup }));

    for (const [retired, replacement] of Object.entries(RETIRED_TOOLS)) {
      const result = await dispatchUnknown({ name: retired, registry });
      expect(result, retired).toContain(`was replaced by "${replacement.tool}"`);
      expect(result.length, retired).toBeLessThanOrEqual(200);
    }
  });

  // An entry dropped from the table is invisible to the walk above: it only
  // checks what is still there, and one edit did silently drop `exec_command`
  // when `append_file` was added. These three names are the ones a saved chat
  // can still replay, so they are asserted by name.
  it('keeps the retired names a saved chat replays: exec_command, append_file, create_directory', async () => {
    const registry = new ToolRegistry();
    for (const name of ['shell', 'write_file']) registry.register(tool(name));
    for (const name of ['exec_command', 'append_file', 'create_directory']) {
      expect(RETIRED_TOOLS, name).toHaveProperty(name);
    }

    const shell = await dispatchUnknown({ name: 'exec_command', registry });
    expect(shell).toContain('was replaced by "shell"');
    expect(shell).toContain('one command line in "command"');
    const append = await dispatchUnknown({ name: 'append_file', registry });
    expect(append).toContain('was replaced by "write_file"');
    expect(append).toContain('mode: "append"');
    const dir = await dispatchUnknown({ name: 'create_directory', registry });
    expect(dir).toContain('was replaced by "write_file"');
    expect(dir).toContain('shell mkdir for a bare folder');
  });

  it('keeps the load_tool_group instruction for a retired lazy-group tool', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('git_read'));
    registry.register(tool('load_tool_group', { advertise: hasAvailableLazyGroup }));

    const result = await dispatchUnknown({ name: 'git_status', registry });

    expect(result).toBe(
      'Error: unknown tool "git_status"; it was replaced by "git_read" (operation="status"); ' +
        'group "git" is unloaded; call load_tool_group with "git".',
    );
    expect(result.length).toBeLessThanOrEqual(200);
  });

  // code_intel is offered in every chat since 2026-11-11 (17be1df0), so its
  // retired names need no load_tool_group step.
  it('names the always-offered replacement without a group step', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('code_intel'));
    registry.register(tool('load_tool_group', { advertise: hasAvailableLazyGroup }));

    const result = await dispatchUnknown({ name: 'get_diagnostics', registry });

    expect(result).toBe(
      'Error: unknown tool "get_diagnostics"; it was replaced by "code_intel" (operation="diagnostics").',
    );
  });

  it('suggests a unique eligible truncated name and explains an unloaded group', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'rendered');
    registerMedia(registry, handler);

    const result = await dispatchUnknown({ name: 'generate_im', registry });

    expect(result).toBe(
      'Error: unknown tool "generate_im"; group "media" is unloaded; call load_tool_group with "media" first to use "generate_image"',
    );
    expect(handler).not.toHaveBeenCalled();
  });

  // Exact-name dispatch remains supported when the group is unloaded; member
  // names in the description also let models find those tools directly.
  it("runs an unloaded group's tool when called by its exact name", async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'image');
    registerMedia(registry, handler);

    expect(await dispatchUnknown({ name: 'generate_image', registry })).toBe('image');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('suggests the candidate without a loader instruction once its group is active', async () => {
    const registry = new ToolRegistry();
    registerMedia(registry);
    activateLazyGroup('conv-a', 'media');

    const result = await dispatchUnknown({ name: 'generate_im', registry });

    expect(result).toBe('Error: unknown tool "generate_im"; did you mean "generate_image"?');
  });

  it('keeps the bare refusal for ambiguous prefixes', async () => {
    const registry = new ToolRegistry();
    registerMedia(registry);
    registry.register(tool('generate_image_hd'));

    expect(await dispatchUnknown({ name: 'generate_im', registry })).toBe(
      'Error: unknown tool "generate_im"',
    );
  });

  it('does not hint for prefixes shorter than five characters', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('render_html_to_image'));

    expect(await dispatchUnknown({ name: 'rend', registry })).toBe('Error: unknown tool "rend"');
  });

  it('does not suggest a tool withheld by permission, advertisement, or model allowlist', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('render_html_to_image', { permission: 'fetch' }));
    registry.register(tool('render_html_to_text', { advertise: () => false }));

    expect(
      await dispatchUnknown({
        name: 'render_html',
        registry,
        allowed: new Set<ToolPermission>(['read']),
      }),
    ).toBe('Error: unknown tool "render_html"');

    const allowlisted = new ToolBudget({ tools: ['read_file'] });
    expect(await dispatchUnknown({ name: 'render_html', registry, budget: allowlisted })).toBe(
      'Error: unknown tool "render_html"',
    );
  });

  it('does not suggest a zero-call-budget candidate', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('render_html_to_image'));
    const budget = new ToolBudget({ tool_call_limits: { render_html_to_image: 0 } });

    expect(await dispatchUnknown({ name: 'render_html', registry, budget })).toBe(
      'Error: unknown tool "render_html"',
    );
  });

  it('does not suggest a vision-withheld candidate', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('view_image', { requiresVision: () => 'vision required' }));

    expect(
      await dispatchUnknown({
        name: 'view_im',
        registry,
        isVisionModel: false,
      }),
    ).toBe('Error: unknown tool "view_im"');
  });

  it('does not give an unloaded-group instruction when the loader is unusable', async () => {
    const registry = new ToolRegistry();
    registerMedia(registry);
    const budget = new ToolBudget({ tool_call_limits: { load_tool_group: 0 } });

    expect(await dispatchUnknown({ name: 'generate_im', registry, budget })).toBe(
      'Error: unknown tool "generate_im"',
    );
  });

  it('omits a hint when the combined refusal would exceed 200 characters', async () => {
    const registry = new ToolRegistry();
    const prefix = 'x'.repeat(140);
    registry.register(tool(`${prefix}_complete_name`));

    const result = await dispatchUnknown({
      name: prefix,
      registry,
    });

    expect(result).toBe(`Error: unknown tool "${prefix}"`);
    expect(result.length).toBeLessThan(200);
  });
});
