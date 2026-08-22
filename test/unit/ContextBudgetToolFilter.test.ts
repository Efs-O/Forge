import { describe, expect, it, vi } from 'vitest';

// The publisher writes the HalluMeter bridge file into the real home directory
// whenever it publishes a usable budget. Keep the test off the user's disk.
vi.mock('fs', () => ({ mkdirSync: vi.fn(), writeFileSync: vi.fn() }));

import {
  ContextBudgetPublisher,
  type ContextBudgetDeps,
} from '../../src/sidebar/ContextBudgetPublisher';
import { computeContextBudget, estimateToolTokens } from '../../src/util/contextBudget';
import { ToolBudget } from '../../src/tools/ToolBudget';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of ['read_file', 'get_profile']) {
    reg.register({
      definition: {
        type: 'function',
        function: {
          name,
          // Long enough that dropping it moves the estimate well past rounding.
          description: `${name} description `.repeat(20),
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
      permission: 'read',
      handler: async () => '',
    });
  }
  return reg;
}

type GroupOverride = { tools?: string[]; tool_call_limits?: Record<string, number> };

function config(group: GroupOverride = {}): ForgeConfig {
  return {
    models: [
      {
        name: 'local',
        provider: 'llama.cpp',
        gguf_path: '/local.gguf',
        num_ctx: 32768,
        group: 'gguf',
      },
    ],
    groups: { gguf: group },
    active_model: 'local',
    llama_server: { port: 8080, n_parallel: 1 },
  } as unknown as ForgeConfig;
}

function conversation(usage?: Partial<ConversationRuntime>): ConversationRuntime {
  return {
    id: 'tab0',
    title: 'Tab',
    createdAt: 1,
    updatedAt: 1,
    active_model: 'local',
    messages: [{ role: 'user', content: 'hi' }],
    ...usage,
  } as ConversationRuntime;
}

function publish(
  conv: ConversationRuntime,
  overrides: Partial<ContextBudgetDeps> = {},
  evaluateThresholds = false,
): HostToWebview[] {
  const sidebar: SidebarRuntime = {
    activeConversationId: conv.id,
    conversations: [conv],
    history: [],
  };
  const posted: HostToWebview[] = [];
  const publisher = new ContextBudgetPublisher({
    getConfig: () => config(),
    getSidebar: () => sidebar,
    post: (msg) => posted.push(msg),
    baseOf: (id) => (id ? (id.split('@')[0] ?? null) : null),
    autoCompact: async () => {},
    manualCompact: () => {},
    ...overrides,
  } as ContextBudgetDeps);
  publisher.publish(conv, evaluateThresholds);
  return posted;
}

function budgetOf(posted: HostToWebview[]): { used: number; max: number } {
  const msg = posted.find((m) => m.type === 'tokenBudget');
  if (!msg || msg.type !== 'tokenBudget') throw new Error('no tokenBudget posted');
  return { used: msg.used, max: msg.max };
}

describe('ContextBudgetPublisher reports measured context only', () => {
  it('posts the provider-reported prompt + completion of the last request', () => {
    const conv = conversation({ last_input_tokens: 12_000, last_output_tokens: 345 });
    expect(budgetOf(publish(conv))).toEqual({ used: 12_345, max: 32_768 });
  });

  it('posts 0 before the first response instead of estimating the transcript', () => {
    // A long transcript with no reported usage yet must not be approximated:
    // the bar reads 0 / max until the server has actually counted something.
    const conv = conversation();
    conv.messages = [{ role: 'user', content: 'x'.repeat(50_000) }];
    expect(budgetOf(publish(conv))).toEqual({ used: 0, max: 32_768 });
  });

  it('is unaffected by which tools the turn advertises', () => {
    // Tool schemas are part of the prompt the server counts, so they are
    // already inside the reported number. Adding an estimate of them on top
    // would double-count.
    const conv = conversation({ last_input_tokens: 12_000, last_output_tokens: 345 });
    const all = budgetOf(publish(conv, { getConfig: () => config() }));
    const narrowed = budgetOf(publish(conv, { getConfig: () => config({ tools: ['read_file'] }) }));
    expect(narrowed).toEqual(all);
  });

  it('divides the window by n_parallel', () => {
    const parallel = () =>
      ({
        ...config(),
        llama_server: { port: 8080, n_parallel: 4 },
      }) as unknown as ForgeConfig;
    const conv = conversation({ last_input_tokens: 100, last_output_tokens: 0 });
    expect(budgetOf(publish(conv, { getConfig: parallel })).max).toBe(8192);
  });
});

describe('ContextBudgetPublisher thresholds', () => {
  function withAutoCompact(fraction: number, at?: number): boolean {
    const used = Math.round(32_768 * fraction);
    const conv = conversation({ last_input_tokens: used, last_output_tokens: 0 });
    let compacted = false;
    publish(
      conv,
      {
        getConfig: () =>
          ({
            ...config(),
            auto_compact: { enabled: true, ...(at !== undefined ? { at } : {}) },
          }) as unknown as ForgeConfig,
        autoCompact: async () => {
          compacted = true;
        },
      },
      true,
    );
    return compacted;
  }

  it('fires auto-compaction at the default 85% and not below it', () => {
    expect(withAutoCompact(0.84)).toBe(false);
    expect(withAutoCompact(0.85)).toBe(true);
  });

  it('honours an explicit threshold', () => {
    expect(withAutoCompact(0.62, 0.6)).toBe(true);
  });

  it('never evaluates thresholds when the caller did not ask', () => {
    const conv = conversation({ last_input_tokens: 32_000, last_output_tokens: 0 });
    let compacted = false;
    publish(conv, {
      getConfig: () => ({ ...config(), auto_compact: { enabled: true } }) as unknown as ForgeConfig,
      autoCompact: async () => {
        compacted = true;
      },
    });
    expect(compacted).toBe(false);
  });
});

describe('output-budget estimate still accounts for advertised tools', () => {
  // Tool filtering moved off the display and onto the only consumer that still
  // needs a projection: the `max_tokens` the next request may generate. The
  // request has not been sent, so nothing has tokenized it and an estimate is
  // the only option available (see TOOL_CALL_TRUNCATION_PLAN.md).
  function outputRoom(group: GroupOverride): number {
    const model = { name: 'local', num_ctx: 32768, ...group } as unknown as ModelConfig;
    const advertised = new ToolBudget(model).filterDefinitions(
      registry().definitions(new Set(['read', 'write', 'execute'] as const)),
    );
    return computeContextBudget({
      messages: [{ role: 'user', content: 'hi' }],
      toolTokens: estimateToolTokens(advertised),
      model,
    }).outputRoom;
  }

  it('leaves more room when a tool is switched off', () => {
    expect(outputRoom({ tool_call_limits: { get_profile: 0 } })).toBeGreaterThan(outputRoom({}));
  });

  it('counts a tool that is merely budget-limited, since it is still advertised', () => {
    expect(outputRoom({ tool_call_limits: { get_profile: 2 } })).toBe(outputRoom({}));
  });

  it('honours a tools allowlist the same way', () => {
    expect(outputRoom({ tools: ['read_file'] })).toBeGreaterThan(outputRoom({}));
  });
});
