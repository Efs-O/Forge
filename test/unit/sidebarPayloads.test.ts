import { describe, expect, it } from 'vitest';
import { buildModelsMessage, buildSessionMetrics } from '../../src/sidebar/sidebarPayloads';
import type { ForgeConfig } from '../../src/config/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

const conv = (over: Partial<ConversationRuntime> = {}): ConversationRuntime =>
  ({ id: 'c1', messages: [], ...over }) as ConversationRuntime;

describe('buildModelsMessage', () => {
  it('defaults an unset provider to llama.cpp and carries the active selection', () => {
    const msg = buildModelsMessage({
      active_model: 'b',
      models: [{ name: 'a' }, { name: 'b', provider: 'ollama' }],
    } as ForgeConfig);

    expect(msg).toMatchObject({ type: 'models', active: 'b' });
    const models = (msg as { models: Array<{ name: string; provider: string }> }).models;
    expect(models.map((m) => [m.name, m.provider])).toEqual([
      ['a', 'llama.cpp'],
      ['b', 'ollama'],
    ]);
  });
});

describe('buildSessionMetrics', () => {
  it('omits counters the conversation has never recorded', () => {
    // The status bar distinguishes "zero" from "never ran", so absent stays absent.
    expect(buildSessionMetrics(conv(), 1200)).toEqual({ activeMs: 1200, contextTokens: 0 });
  });

  it('reports totals and last-request counters when present', () => {
    const snapshot = buildSessionMetrics(
      conv({ input_tokens: 90, output_tokens: 10, last_input_tokens: 40, model_request_count: 3 }),
      500,
    );
    expect(snapshot).toMatchObject({
      activeMs: 500,
      inputTokens: 90,
      outputTokens: 10,
      currentInputTokens: 40,
      requestCount: 3,
    });
    expect(snapshot).not.toHaveProperty('currentOutputTokens');
  });
});
