import { describe, expect, it, vi } from 'vitest';
import type { BackendController } from '../../src/backend/BackendController';
import { TurnLifecycle } from '../../src/sidebar/TurnLifecycle';

function backend(stop: () => Promise<void>): BackendController {
  return {
    start: async () => undefined,
    stop,
    showConsole: () => undefined,
    isReady: () => true,
    baseUrl: () => 'http://127.0.0.1:8080',
    loadedModel: () => 'model',
    hotSwap: async () => undefined,
    applyForgeConfig: () => undefined,
  };
}

describe('TurnLifecycle steering', () => {
  it('interrupts and settles a request without stopping its loaded backend', async () => {
    const lifecycle = new TurnLifecycle();
    const controller = new AbortController();
    const stop = vi.fn(async () => undefined);
    lifecycle.register('conv-1', controller);
    lifecycle.markStreaming('conv-1');
    lifecycle.setBackend('conv-1', backend(stop));
    controller.signal.addEventListener(
      'abort',
      () => {
        lifecycle.clearStreaming('conv-1');
        lifecycle.settle('conv-1');
      },
      { once: true },
    );

    await lifecycle.interrupt('conv-1');

    expect(controller.signal.aborted).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(lifecycle.isStreaming('conv-1')).toBe(false);
    expect(lifecycle.isCancellationPending('conv-1')).toBe(false);
  });
});

describe('TurnLifecycle cancel', () => {
  /** The Stop button used to SIGTERM llama-server on every press: a full model
   *  reload to cancel one generation, and under a shared runtime it killed the
   *  server a second window had borrowed. Aborting the request is what ends
   *  generation; the process must survive. */
  it('cancels a request without stopping its loaded backend', async () => {
    const lifecycle = new TurnLifecycle();
    const controller = new AbortController();
    const stop = vi.fn(async () => undefined);
    lifecycle.register('conv-1', controller);
    lifecycle.markStreaming('conv-1');
    lifecycle.setBackend('conv-1', backend(stop));
    controller.signal.addEventListener(
      'abort',
      () => {
        lifecycle.clearStreaming('conv-1');
        lifecycle.settle('conv-1');
      },
      { once: true },
    );

    await lifecycle.cancel('conv-1');

    expect(controller.signal.aborted).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(lifecycle.isStreaming('conv-1')).toBe(false);
  });

  /** Closing a tab routes through stopStreaming's default. Same hazard. */
  it('stops streaming on tab close without stopping the backend', async () => {
    const lifecycle = new TurnLifecycle();
    const controller = new AbortController();
    const stop = vi.fn(async () => undefined);
    lifecycle.register('conv-1', controller);
    lifecycle.markStreaming('conv-1');
    lifecycle.setBackend('conv-1', backend(stop));
    controller.signal.addEventListener('abort', () => lifecycle.settle('conv-1'), { once: true });

    await lifecycle.stopStreaming('conv-1');

    expect(controller.signal.aborted).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });
});
