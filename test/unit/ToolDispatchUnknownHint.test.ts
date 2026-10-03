import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { ChatMessage, ToolCall } from '../../src/llm/types';
import { ToolBudget } from '../../src/tools/ToolBudget';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
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
    vi.fn(async () => true),
    {} as DiffDecorations,
  );
}

function registerMedia(registry: ToolRegistry, imageHandler = vi.fn(async () => 'image')): void {
  registry.register(tool('render_html_to_image', {}, imageHandler));
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

  it('suggests a unique eligible truncated name and explains an unloaded group', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'rendered');
    registerMedia(registry, handler);

    const result = await dispatchUnknown({ name: 'render_html', registry });

    expect(result).toBe(
      'Error: unknown tool "render_html"; group "media" is unloaded; call load_tool_group with "media" first to use "render_html_to_image"',
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('suggests the candidate without a loader instruction once its group is active', async () => {
    const registry = new ToolRegistry();
    registerMedia(registry);
    activateLazyGroup('conv-a', 'media');

    const result = await dispatchUnknown({ name: 'render_html', registry });

    expect(result).toBe('Error: unknown tool "render_html"; did you mean "render_html_to_image"?');
  });

  it('keeps the bare refusal for ambiguous prefixes', async () => {
    const registry = new ToolRegistry();
    registerMedia(registry);
    registry.register(tool('render_html_to_text'));

    expect(await dispatchUnknown({ name: 'render_html', registry })).toBe(
      'Error: unknown tool "render_html"',
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

    expect(await dispatchUnknown({ name: 'render_html', registry, budget })).toBe(
      'Error: unknown tool "render_html"',
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
