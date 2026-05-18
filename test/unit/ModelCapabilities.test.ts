import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectRuntimeModelCapabilities } from '../../src/backend/ModelCapabilities';
import type { ModelConfig } from '../../src/config/types';

const model: ModelConfig = {
  name: 'qwen3-test',
  gguf_path: 'C:/models/qwen3.gguf',
  think: true,
};

describe('inspectRuntimeModelCapabilities', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses runtime props when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        chat_template: '{{ enable_thinking }} {{ tool_calls }}',
        chat_template_caps: { supports_tools: true, supports_thinking: true },
      }),
    }));

    const caps = await inspectRuntimeModelCapabilities('http://127.0.0.1:8080', model);
    expect(caps.source).toBe('runtime');
    expect(caps.hasChatTemplate).toBe(true);
    expect(caps.likelySupportsTools).toBe(true);
    expect(caps.likelySupportsThinking).toBe(true);
  });

  it('falls back to heuristics when props are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const caps = await inspectRuntimeModelCapabilities('http://127.0.0.1:8080', model);
    expect(caps.source).toBe('heuristic');
    expect(caps.likelySupportsThinking).toBe(true);
    expect(caps.likelySupportsTools).toBe(true);
    expect(caps.hasChatTemplate).toBeNull();
  });

  it('marks missing runtime templates as unsupported for template-driven features', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        chat_template: '',
        chat_template_caps: {},
      }),
    }));

    const caps = await inspectRuntimeModelCapabilities('http://127.0.0.1:8080', {
      name: 'plain-base-model',
      gguf_path: 'C:/models/plain.gguf',
    });
    expect(caps.source).toBe('runtime');
    expect(caps.hasChatTemplate).toBe(false);
    expect(caps.likelySupportsTools).toBe(false);
    expect(caps.likelySupportsThinking).toBe(false);
  });
});
