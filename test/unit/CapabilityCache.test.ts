import { describe, expect, it, vi } from 'vitest';
import { CapabilityCache } from '../../src/sidebar/CapabilityCache';
import type { RuntimeModelCapabilities } from '../../src/backend/ModelCapabilities';
import type { ModelConfig } from '../../src/config/types';

const model = { name: 'qwen3-27b' } as ModelConfig;

function caps(source: RuntimeModelCapabilities['source']): RuntimeModelCapabilities {
  return {
    source,
    hasChatTemplate: source === 'runtime',
    likelySupportsTools: source === 'runtime' ? true : null,
    likelySupportsThinking: source === 'runtime' ? true : null,
    chatTemplate: source === 'runtime' ? '{{ tools }}' : null,
  };
}

describe('CapabilityCache', () => {
  it('memoizes a runtime-sourced probe', async () => {
    const probe = vi.fn().mockResolvedValue(caps('runtime'));
    const cache = new CapabilityCache(probe);

    await cache.get(model, 'http://localhost:8080');
    await cache.get(model, 'http://localhost:8080');

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes after a degraded answer so a cold backend self-heals', async () => {
    // First turn races the backend coming up: /props is unreachable and
    // inspectRuntimeModelCapabilities falls back to name heuristics. Caching
    // that would strand the model without thinking kwargs for the session.
    const probe = vi
      .fn()
      .mockResolvedValueOnce(caps('heuristic'))
      .mockResolvedValueOnce(caps('runtime'));
    const cache = new CapabilityCache(probe);

    const cold = await cache.get(model, 'http://localhost:8080');
    expect(cold.source).toBe('heuristic');
    expect(cold.likelySupportsThinking).toBeNull();

    const warm = await cache.get(model, 'http://localhost:8080');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(warm.source).toBe('runtime');
    expect(warm.likelySupportsThinking).toBe(true);

    // ...and the good answer sticks.
    await cache.get(model, 'http://localhost:8080');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('re-probes after an unknown answer too', async () => {
    const probe = vi.fn().mockResolvedValue(caps('unknown'));
    const cache = new CapabilityCache(probe);

    await cache.get(model, 'http://localhost:8080');
    await cache.get(model, 'http://localhost:8080');

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight probe between concurrent turns', async () => {
    let release!: (value: RuntimeModelCapabilities) => void;
    const probe = vi.fn().mockReturnValue(
      new Promise<RuntimeModelCapabilities>((resolve) => {
        release = resolve;
      }),
    );
    const cache = new CapabilityCache(probe);

    const both = Promise.all([
      cache.get(model, 'http://localhost:8080'),
      cache.get(model, 'http://localhost:8080'),
    ]);
    release(caps('runtime'));
    const [a, b] = await both;

    expect(probe).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('does not evict an entry a newer probe already replaced', async () => {
    let releaseFirst!: (value: RuntimeModelCapabilities) => void;
    const probe = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<RuntimeModelCapabilities>((resolve) => {
          releaseFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(caps('runtime'));
    const cache = new CapabilityCache(probe);

    const stale = cache.get(model, 'http://localhost:8080');
    cache.clear();
    await cache.get(model, 'http://localhost:8080');
    // The first probe resolves degraded only now — it must not delete the
    // good entry that replaced it.
    releaseFirst(caps('heuristic'));
    await stale;

    await cache.get(model, 'http://localhost:8080');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('warns once per key and forgets on clear', () => {
    const cache = new CapabilityCache(vi.fn());
    const show = vi.fn();

    cache.warnOnce('qwen3-27b:thinking', 'no thinking toggles', show);
    cache.warnOnce('qwen3-27b:thinking', 'no thinking toggles', show);
    expect(show).toHaveBeenCalledTimes(1);

    cache.warnOnce('qwen3-27b:tools', 'no tool template', show);
    expect(show).toHaveBeenCalledTimes(2);

    cache.clear();
    cache.warnOnce('qwen3-27b:thinking', 'no thinking toggles', show);
    expect(show).toHaveBeenCalledTimes(3);
  });
});
