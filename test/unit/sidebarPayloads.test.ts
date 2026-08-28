import { describe, expect, it } from 'vitest';
import { buildModelsMessage, buildSessionMetrics } from '../../src/sidebar/sidebarPayloads';
import type { ForgeConfig } from '../../src/config/types';
import type { ModelEntry } from '../../src/sidebar/messageBridge';
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

  it('uses an active conversation pin instead of the config default when supplied', () => {
    const msg = buildModelsMessage(
      {
        active_model: 'no-vision',
        models: [{ name: 'vision' }, { name: 'no-vision' }],
      } as ForgeConfig,
      undefined,
      'vision',
    );

    expect(msg).toMatchObject({ type: 'models', active: 'vision' });
  });

  it('omits residency entirely when no pool is supplied', () => {
    const msg = buildModelsMessage({ active_model: 'a', models: [{ name: 'a' }] } as ForgeConfig);
    expect((msg as { models: ModelEntry[] }).models[0]).not.toHaveProperty('residency');
  });

  it('maps a local model through cold / loading / ready', () => {
    const config = { active_model: 'a', models: [{ name: 'a' }] } as ForgeConfig;
    const at = (loaded: boolean, ready: boolean): ModelEntry | undefined =>
      (buildModelsMessage(config, { isLoaded: () => loaded, isModelReady: () => ready }) as {
        models: ModelEntry[];
      }).models[0];

    expect(at(false, false)?.residency).toBe('cold');
    expect(at(true, false)?.residency).toBe('loading');
    expect(at(true, true)?.residency).toBe('ready');
  });

  it('reports no residency for remote routes, Ollama cloud included', () => {
    // Ollama cloud reaches the daemon on localhost but holds no VRAM here, so a
    // "cold" dot would advertise a load cost that does not exist. Note the route
    // is decided by the `-cloud`/`:cloud` NAME suffix, not by the endpoint.
    const msg = buildModelsMessage(
      {
        active_model: 'gpt-oss:120b-cloud',
        models: [
          { name: 'gpt-oss:120b-cloud', provider: 'ollama' },
          { name: 'y', provider: 'xai' },
          { name: 'z', provider: 'openrouter' },
        ],
      } as ForgeConfig,
      { isLoaded: () => false, isModelReady: () => false },
    );

    for (const model of (msg as { models: ModelEntry[] }).models) {
      expect(model).not.toHaveProperty('residency');
    }
  });

  it('still reports residency for a local Ollama model', () => {
    const msg = buildModelsMessage(
      {
        active_model: 'q',
        models: [{ name: 'q', provider: 'ollama', endpoint: 'http://localhost:11434' }],
      } as ForgeConfig,
      { isLoaded: () => true, isModelReady: () => true },
    );
    expect((msg as { models: ModelEntry[] }).models[0]?.residency).toBe('ready');
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
