import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { LocalDelegationService, LocalDelegationResult } from '../../src/delegation/LocalDelegationService';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import {
  makeLocalAgentTool,
  makeListDelegationTargetsTool,
  hasEligibleDelegationTargets,
  describeDelegationTargets,
} from '../../src/tools/localAgentTool';
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

const mixedConfig = makeConfig([
  model('llama', 'llama.cpp'),
  model('ollama-local', 'ollama', 'http://127.0.0.1:11434'),
  model('openrouter-model', 'openrouter'),
  { name: 'claude-code', provider: 'cli', cli: 'claude' },
]);

const cloudOnlyConfig = makeConfig([
  model('xai-model', 'xai'),
  model('openai-model', 'openai'),
  model('openrouter-model', 'openrouter'),
]);

// The only remaining shape that resolves to no eligible target at all: a
// remote Ollama daemon Forge holds no auth for.
const ineligibleConfig = makeConfig([model('ollama-remote', 'ollama', 'https://ollama.com')]);

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

  it('returns true when only configured cloud providers exist', () => {
    expect(hasEligibleDelegationTargets(cloudOnlyConfig)).toBe(true);
  });

  it('returns false when the only model is a non-local Ollama endpoint', () => {
    expect(hasEligibleDelegationTargets(ineligibleConfig)).toBe(false);
  });

  it('returns false for empty model list', () => {
    expect(hasEligibleDelegationTargets(emptyConfig)).toBe(false);
  });

  it('returns true for an Ollama cloud-tag model on the local daemon', () => {
    const cfg = makeConfig([model('gpt-oss:20b-cloud', 'ollama', 'http://127.0.0.1:11434')]);
    expect(hasEligibleDelegationTargets(cfg)).toBe(true);
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

  it('states that delegation does not require terminal permission', () => {
    const { service } = makeMockService();
    const tool = makeLocalAgentTool(service, () => localConfig);
    expect(tool.definition.function.description).toContain('only the delegate permission');
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

  it('advertises when only configured cloud targets exist', () => {
    const { service } = makeMockService();
    const registry = new ToolRegistry();
    registry.register(makeLocalAgentTool(service, () => cloudOnlyConfig));
    const defs = registry.definitions(new Set(['delegate']));
    expect(defs.some((d) => d.function.name === 'ask_local_agent')).toBe(true);
  });

  it('does not advertise when no eligible targets exist', () => {
    const { service } = makeMockService();
    const registry = new ToolRegistry();
    registry.register(makeLocalAgentTool(service, () => ineligibleConfig));
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

  it('throws when no eligible targets are configured', async () => {
    const { service } = makeMockService();
    const tool = makeLocalAgentTool(service, () => ineligibleConfig);

    await expect(tool.handler({ model: 'llama', task: 'check' })).rejects.toThrow(
      'no eligible delegation targets',
    );
  });

  it('delegates to a configured cloud model', async () => {
    const { service, ask } = makeMockService();
    const tool = makeLocalAgentTool(service, () => cloudOnlyConfig);

    await tool.handler({ model: 'openrouter-model', task: 'second opinion' });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ targetModel: 'openrouter-model', task: 'second opinion' }),
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

// ── Target hint in the schema ───────────────────────────────────────────────

describe('describeDelegationTargets', () => {
  it('names each eligible target with its kind', () => {
    const hint = describeDelegationTargets(localConfig);
    expect(hint).toContain('"llama" (local)');
    expect(hint).toContain('"ollama-local" (local Ollama)');
  });

  it('labels configured cloud models as cloud', () => {
    expect(describeDelegationTargets(cloudOnlyConfig)).toContain('"openrouter-model" (cloud)');
  });

  // The user's real config sets provider on the GROUP, not the model, so the
  // hint is only correct if it resolves through the same flattening the
  // delegation path uses.
  it('resolves a provider inherited from the model group', () => {
    const cfg = makeConfig([{ name: 'qwen/qwen3.8-max', group: 'openrouter-cloud' }]);
    cfg.groups = { 'openrouter-cloud': { provider: 'openrouter' } };
    expect(describeDelegationTargets(cfg)).toContain('"qwen/qwen3.8-max" (cloud)');
  });

  it('flags cli agents as carrying their own tools', () => {
    const cfg = makeConfig([{ name: 'claude-code', provider: 'cli', cli: 'claude' }]);
    expect(describeDelegationTargets(cfg)).toContain('"claude-code" (CLI agent, has its own tools)');
  });

  it('omits ineligible targets and returns empty when none are eligible', () => {
    expect(describeDelegationTargets(ineligibleConfig)).toBe('');
  });

  // The whole list used to live in the schema on every turn. Only the CLI
  // agents are named there now; the rest is one list_delegation_targets away.
  it('names only the cli agents in the model arg description ToolRegistry advertises', () => {
    const { service } = makeMockService();
    const registry = new ToolRegistry();
    registry.register(makeLocalAgentTool(service, () => mixedConfig));
    const def = registry
      .definitions(new Set(['delegate']))
      .find((d) => d.function.name === 'ask_local_agent');
    const params = def?.function.parameters as {
      properties: { model: { description: string } };
    };
    expect(params.properties.model.description).toContain('"claude-code"');
    expect(params.properties.model.description).toContain('list_delegation_targets');
    expect(params.properties.model.description).not.toContain('"llama"');
    expect(params.properties.model.description).toContain('do NOT read');
  });

  it('ranks cli agents above cloud above local, and warns on the local section', () => {
    const listed = describeDelegationTargets(mixedConfig);
    expect(listed.indexOf('"claude-code"')).toBeLessThan(listed.indexOf('"openrouter-model"'));
    expect(listed.indexOf('"openrouter-model"')).toBeLessThan(listed.indexOf('"llama"'));
    expect(listed).toContain('VRAM');
  });

  // Cloud-routed Ollama reaches the daemon like a local one but runs remotely,
  // so it must not be filed under the VRAM warning.
  it('files a cloud-routed ollama model with cloud, not local', () => {
    const cfg = makeConfig([
      model('llama', 'llama.cpp'),
      model('kimi-k2.6:cloud', 'ollama'),
    ]);
    const listed = describeDelegationTargets(cfg);
    expect(listed.indexOf('"kimi-k2.6:cloud"')).toBeLessThan(listed.indexOf('"llama"'));
  });

  // The canonical `definition` literal stays static — scripts/tool-audit-catalog.mjs
  // extracts it from source, so it must remain a plain object literal.
  it('leaves the static definition untouched', () => {
    const { service } = makeMockService();
    const tool = makeLocalAgentTool(service, () => localConfig);
    const params = tool.definition.function.parameters as {
      properties: { model: { description: string } };
    };
    expect(params.properties.model.description).not.toContain('"llama" (local)');
  });

  // ToolRegistry.definitions() re-reads `definition` every turn; a config
  // reload must show up without re-registering the tool.
  it('refreshes when the config changes', () => {
    const { service } = makeMockService();
    let cfg = mixedConfig;
    const tool = makeLocalAgentTool(service, () => cfg);
    const read = () =>
      (
        tool.describe!().function.parameters as {
          properties: { model: { description: string } };
        }
      ).properties.model.description;
    expect(read()).toContain('"claude-code"');
    cfg = cloudOnlyConfig;
    expect(read()).not.toContain('"claude-code"');
  });
});

// ── Discovery tool and the local-VRAM approval gate ─────────────────────────

describe('list_delegation_targets', () => {
  it('returns the ranked list, and says so when there is nothing to list', async () => {
    const listed = await makeListDelegationTargetsTool(() => mixedConfig).handler({});
    expect(listed).toContain('"claude-code"');
    expect(listed).toContain('"llama"');
    expect(await makeListDelegationTargetsTool(() => ineligibleConfig).handler({})).toContain(
      'No delegation targets',
    );
  });

  it('is advertised only alongside an eligible target', () => {
    expect(makeListDelegationTargetsTool(() => mixedConfig).advertise!()).toBe(true);
    expect(makeListDelegationTargetsTool(() => ineligibleConfig).advertise!()).toBe(false);
  });
});

describe('ask_local_agent local-VRAM approval', () => {
  const approvalFor = (target: string) => {
    const { service } = makeMockService();
    return makeLocalAgentTool(service, () => mixedConfig).approval!({ model: target });
  };

  it('asks before a target that loads local weights', () => {
    expect(approvalFor('llama')?.detail).toContain('local VRAM');
    expect(approvalFor('ollama-local')?.detail).toContain('local VRAM');
  });

  it('does not ask for cli or cloud targets, which take no slot', () => {
    expect(approvalFor('claude-code')).toBeUndefined();
    expect(approvalFor('openrouter-model')).toBeUndefined();
  });

  // A fuzzy alias or `model@profile` still resolves in the handler, so an
  // unrecognised name must fall to the safe side rather than through the gate.
  it('asks when the name does not match a known target', () => {
    expect(approvalFor('llama@fast')?.detail).toContain('local VRAM');
  });
});
