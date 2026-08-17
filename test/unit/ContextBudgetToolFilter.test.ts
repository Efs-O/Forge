import { describe, expect, it, vi } from 'vitest';

// The publisher writes the HalluMeter bridge file into the real home directory
// whenever it publishes a usable budget. Keep the test off the user's disk.
vi.mock('fs', () => ({ mkdirSync: vi.fn(), writeFileSync: vi.fn() }));

import {
  ContextBudgetPublisher,
  type ContextBudgetDeps,
} from '../../src/sidebar/ContextBudgetPublisher';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { ForgeConfig } from '../../src/config/types';
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

function config(group: GroupOverride): ForgeConfig {
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

function conversation(): ConversationRuntime {
  return {
    id: 'tab0',
    title: 'Tab',
    createdAt: 1,
    updatedAt: 1,
    active_model: 'local',
    messages: [{ role: 'user', content: 'hi' }],
  } as ConversationRuntime;
}

/** Publishes one budget and returns the `used` token count posted to the webview. */
function publishedTokens(group: GroupOverride = {}): number {
  const conv = conversation();
  const sidebar: SidebarRuntime = {
    activeConversationId: conv.id,
    conversations: [conv],
    history: [],
  };
  const posted: HostToWebview[] = [];
  const publisher = new ContextBudgetPublisher({
    getConfig: () => config(group),
    getSidebar: () => sidebar,
    toolRegistry: registry(),
    post: (msg) => posted.push(msg),
    baseOf: (id) => (id ? id.split('@')[0] : null),
    autoCompact: async () => {},
    manualCompact: () => {},
  } as ContextBudgetDeps);

  publisher.publish(conv, false);
  const budget = posted.find((m) => m.type === 'tokenBudget');
  if (!budget || budget.type !== 'tokenBudget') throw new Error('no tokenBudget posted');
  return budget.used;
}

describe('ContextBudgetPublisher tool accounting', () => {
  it('excludes tools the turn will not advertise', () => {
    const withTool = publishedTokens();
    const zeroed = publishedTokens({ tool_call_limits: { get_profile: 0 } });

    // ModelTurn drops a zero-budget tool from the request, so its schema never
    // reaches the prompt. Counting the unfiltered registry made switching a
    // tool off leave the bar unchanged.
    expect(zeroed).toBeLessThan(withTool);
  });

  it('counts a tool that is merely budget-limited, since it is still advertised', () => {
    expect(publishedTokens({ tool_call_limits: { get_profile: 2 } })).toBe(publishedTokens());
  });

  it('honours a tools allowlist the same way', () => {
    expect(publishedTokens({ tools: ['read_file'] })).toBeLessThan(publishedTokens());
  });
});
