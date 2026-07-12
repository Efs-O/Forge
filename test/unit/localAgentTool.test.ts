import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { LocalDelegationService, LocalDelegationResult } from '../../src/delegation/LocalDelegationService';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { makeLocalAgentTool, hasEligibleDelegationTargets } from '../../src/tools/localAgentTool';
import {
  MAX_DELEGATION_TASK_CHARS,
  MAX_DELEGATION_CONTEXT_FILES,
  HARD_MAX_DELEGATION_OUTPUT_TOKENS,
} from '../../src/delegation/limits';

// ── Config helpers ──────────────────────────────────────────────────────────

function model(name: string, provider?: ModelConfig['provider'], endpoint?: string): ModelConfig {
  return {
    name,
    ...(provider ? { provider } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...((!provider || provider === 'llama.cpp') ? { gguf_path: `/${name}.gguf` } : {}),
  };
}

function makeConfig(models: ModelConfig[]): ForgeConfig {
  return {
    models,
    active_model: models[0]?.name ?? null,
    llama_server: {},
  };
}

const localConfig = makeConfig([
  model('llama', 'llama.cpp'),
  model('ollama-local', 'ollama', 'http://127.0.0.1:11434'),
]);

const cloudOnlyConfig = makeConfig([
  model('xai-model', 'xai'),
  model('openai-model', 'openai'),
  model('openrouter-model', 'openrouter'),
]);

const emptyConfig = makeConfig([]);

// ── Mock LocalDelegationService ─────────────────────────────────────────────

function makeMockService(
  askResult: LocalDelegationResult = { text: 'analysis text', targetModel: 'llama', bestEffort: false },
): {
  service: LocalDelegationService;
  ask: ReturnType<typeof vi.fn>;
} {
  const ask = vi.fn().mockResolvedValue(askResult);
  const service = { ask } as unknown as LocalDelegationService;
  return { service, ask };
}

// ── hasEligibleDelegationTargets ────────────────────────────────────────────

describe('hasEligibleDelegationTargets', () => {
  it('returns true when a llama.cpp model is configured', () => {
    expect(hasEligibleDelegationTargets(localConfig)).toBe(true);
  });

  it('returns true when a local ollama model is configured', () => {
    const cfg = makeConfig([model('ollama-local', 'ollama', 'http://127.0.0.1:11434')]);
    expect(hasEligibleDelegationTargets(cfg)).toBe(true);
  });

  it('returns false when only cloud providers are configured', () => {
    expect(hasEligibleDelegationTargets(cloudOnlyConfig)).toBe(false);
  });

  it('returns false for empty model list', () => {
    expect(hasEligibleDelegationTargets(emptyConfig)).toBe(false);
  });

  it('returns false for Ollama cloud-tag model', () => {
    const cfg = makeConfig([model('gpt-oss:20b-cloud', 'ollama', 'http://127.0.0.1:11434')]);
    expect(hasEligibleDelegationTargets(cfg)).toBe(false);
  });
});

// ── Schema ──────────────────────────────────────────────────────────────────

describe('ask_local_agent schema', () => {
  function getSchema() {
    const { service } = makeMockService();
    const tool = makeLocalAgentTool(service, () => localConfig);
    return tool.definition.function.parameters;
  }

  it('has additionalProperties: false', () => {
    expect(getSchema().additionalProperties).toBe(false);
  });

  it('requires model and task', () => {
    expect(getSchema().required).toEqual(['model', 'task']);
  });

  it('task has maxLength equal to MAX_DELEGATION_TASK_CHARS', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema inspection
    const schema = getSchema() as any;
    expect(schema.properties.task.maxLength).toBe(MAX_DELEGATION_TASK_CHARS);
  });

  it('context_files has maxItems equal to MAX_DELEGATION_CONTEXT_FILES', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema inspection
    const schema = getSchema() as any;
    expect(schema.properties.context_files.maxItems).toBe(MAX_DELEGATION_CONTEXT_FILES);
  });

  it('max_output_tokens has maximum equal to HARD_MAX_DELEGATION_OUTPUT_TOKENS', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema inspection
    const schema = getSchema() as any;
    expect(schema.properties.max_output_tokens.maximum).toBe(HARD_MAX_DELEGATION_OUTPUT_TOKENS);
    expect(schema.properties.max_output_tokens.minimum).toBe(1);
  });

  it('focus is an enum of the expected values', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema inspection
    const schema = getSchema() as any;
    expect(schema.properties.focus.enum).toEqual([
      'correctness',
      'security',
      'tests',
      'architecture',
      'performance',
      'second-opinion',
    ]);
  });

  it('has permission delegate', () => {
    const { service } = makeMockService();
    const tool = makeLocalAgentTool(service, () => localConfig);
    expect(tool.permission).toBe('delegate');
  });
});

// ── Advertisement ───────────────────────────────────────────────────────────

describe('advertisement', () => {
  it('advertises when delegate permission is in allowed set and eligible targets exist', () => {
    const { service } = makeMockService();
    const registry = new ToolRegistry();
    registry.register(makeLocalAgentTool(service, () => localConfig));
    const defs = registry.definitions(new Set(['delegate']));
    expect(defs.some((d) => d.function.name === 'ask_local_agent')).toBe(true);
  });

  it('does not advertise when delegate permission is absent from allowed set', () => {
    const { service } = makeMockService();
    const registry = new ToolRegistry();
    registry.register(makeLocalAgentTool(service, () => localConfig));
    const defs = registry.definitions(new Set(['read', 'write']));
    expect(defs.some((d) => d.function.name === 'ask_local_agent')).toBe(false);
  });

  it('does not advertise when no eligible local targets exist', () => {
    const { service } = makeMockService();
    const registry = new ToolRegistry();
    registry.register(makeLocalAgentTool(service, () => cloudOnlyConfig));
    const defs = registry.definitions(new Set(['delegate']));
    expect(defs.some((d) => d.function.name === 'ask_local_agent')).toBe(false);
  });

  it('does not advertise with empty model list', () => {
    const { service } = makeMockService();
    const registry = new ToolRegistry();
    registry.register(makeLocalAgentTool(service, () => emptyConfig));
    const defs = registry.definitions(new Set(['delegate']));
    expect(defs.some((d) => d.function.name === 'ask_local_agent')).toBe(false);
  });
});

// ── Permission gating (native and fallback paths both use registry.dispatch) ─

describe('permission gating', () => {
  let registry: ToolRegistry;
  let ask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mock = makeMockService();
    ask = mock.ask;
    registry = new ToolRegistry();
    registry.register(makeLocalAgentTool(mock.service, () => localConfig));
  });

  it('dispatch succeeds when delegate permission is granted', async () => {
    await expect(
      registry.dispatch(
        'ask_local_agent',
        { model: 'llama', task: 'analyze this' },
        new Set(['delegate']),
      ),
    ).resolves.toMatch(/Delegated analysis/);
    expect(ask).toHaveBeenCalledOnce();
  });

  it('dispatch throws when delegate permission is absent (native path)', async () => {
    await expect(
      registry.dispatch(
        'ask_local_agent',
        { model: 'llama', task: 'analyze this' },
        new Set(['read', 'write']),
      ),
    ).rejects.toThrow(/permission "delegate"/);
    expect(ask).not.toHaveBeenCalled();
  });

  it('dispatch throws when delegate permission is absent (fallback path — same registry.dispatch gate)', async () => {
    // Fallback tool calls parsed from JSON-fenced blocks go through the same
    // toolRegistry.dispatch() gate as native calls, so the same check applies.
    await expect(
      registry.dispatch(
        'ask_local_agent',
        { model: 'llama', task: 'review the diff' },
        new Set<'read'>(['read']),
      ),
    ).rejects.toThrow(/permission "delegate"/);
    expect(ask).not.toHaveBeenCalled();
  });
});

// ── Handler ─────────────────────────────────────────────────────────────────

describe('handler', () => {
  it('passes model, task, context_files, focus, max_output_tokens through to service.ask', async () => {
    const { service, ask } = makeMockService();
    const tool = makeLocalAgentTool(service, () => localConfig);

    await tool.handler({
      model: 'llama',
      task: 'analyze the diff',
      context_files: ['src/foo.ts'],
      focus: 'security',
      max_output_tokens: 512,
    });

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryModel: localConfig.active_model,
        targetModel: 'llama',
        task: 'analyze the diff',
        contextFiles: ['src/foo.ts'],
        focus: 'security',
        maxOutputTokens: 512,
      }),
    );
  });

  it('passes caller abortSignal through to service.ask via context', async () => {
    const { service, ask } = makeMockService();
    const tool = makeLocalAgentTool(service, () => localConfig);
    const ctrl = new AbortController();

    await tool.handler(
      { model: 'llama', task: 'check this' },
      { beforeMutate: vi.fn(), abortSignal: ctrl.signal },
    );

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ signal: ctrl.signal }),
    );
  });

  it('omits signal when no context is provided (exactOptionalPropertyTypes)', async () => {
    const { service, ask } = makeMockService();
    const tool = makeLocalAgentTool(service, () => localConfig);

    await tool.handler({ model: 'llama', task: 'check this' });

    expect(ask).toHaveBeenCalledOnce();
    const callArg = ask.mock.calls[0][0] as Record<string, unknown>;
    expect('signal' in callArg).toBe(false);
  });

  it('returns result text prefixed with delegated analysis label', async () => {
    const { service } = makeMockService({ text: 'looks good', targetModel: 'llama', bestEffort: false });
    const tool = makeLocalAgentTool(service, () => localConfig);

    const result = await tool.handler({ model: 'llama', task: 'check' });
    expect(result).toContain('[Delegated analysis — llama]');
    expect(result).toContain('looks good');
  });

  it('appends best-effort note when hold is best-effort', async () => {
    const { service } = makeMockService({ text: 'ok', targetModel: 'llama', bestEffort: true });
    const tool = makeLocalAgentTool(service, () => localConfig);

    const result = await tool.handler({ model: 'llama', task: 'check' });
    expect(result).toContain('best-effort');
  });

  it('surfaces service errors as tool errors (not swallowed)', async () => {
    const ask = vi.fn().mockRejectedValue(new Error('provider timeout'));
    const service = { ask } as unknown as LocalDelegationService;
    const tool = makeLocalAgentTool(service, () => localConfig);

    await expect(tool.handler({ model: 'llama', task: 'check' })).rejects.toThrow('provider timeout');
  });

  it('throws when no eligible local targets are configured', async () => {
    const { service } = makeMockService();
    const tool = makeLocalAgentTool(service, () => cloudOnlyConfig);

    await expect(tool.handler({ model: 'llama', task: 'check' })).rejects.toThrow(
      'no eligible local delegation targets',
    );
  });

  it('uses active_model as primaryModel', async () => {
    const cfg = makeConfig([model('mymodel', 'llama.cpp')]);
    const { service, ask } = makeMockService();
    const tool = makeLocalAgentTool(service, () => cfg);

    await tool.handler({ model: 'mymodel', task: 'check' });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ primaryModel: 'mymodel' }));
  });
});
