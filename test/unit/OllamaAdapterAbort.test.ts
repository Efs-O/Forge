/**
 * An Ollama cold start that is cancelled must report a cancellation, fast.
 *
 * `ensureOllamaReady` tries launch candidates in sequence on ONE abort signal.
 * An abort during a candidate's health wait used to break out of the loop and
 * then call `waitForHealthy` a final time on the already-dead signal, which
 * polled another 10 s and threw "did not become reachable" at a user who had
 * pressed Stop — with a "trying next candidate" warning in the log on the way.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      append: () => {},
      clear: () => {},
      show: () => {},
      dispose: () => {},
    }),
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));

vi.mock('child_process', () => ({
  spawn: () => {
    const child = {
      once: (event: string, cb: () => void) => {
        if (event === 'spawn') setImmediate(cb);
      },
      unref: () => {},
    };
    return child;
  },
}));

import { ensureOllamaReady } from '../../src/backend/OllamaAdapter';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ensureOllamaReady cancellation', () => {
  beforeEach(() => {
    // Every probe fails: the daemon never comes up, so the candidate loop runs.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
  });

  it('rejects with a cancellation when the signal aborts during a candidate wait', async () => {
    const ctrl = new AbortController();
    const startedAt = Date.now();
    const pending = ensureOllamaReady('http://127.0.0.1:11434', ctrl.signal);
    // Let the first candidate spawn and start its 15 s health wait.
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctrl.abort();

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('rejects with a cancellation when the signal aborts during the FINAL wait', async () => {
    // No candidates are attempted, so the abort lands inside the last 10 s
    // `waitForHealthy`. Its result is `reason: 'aborted'`, and reporting
    // "did not become reachable … start it with ollama serve yourself" for a
    // user who pressed Stop is wrong advice on top of the dead-signal poll.
    const ctrl = new AbortController();
    const startedAt = Date.now();
    const pending = ensureOllamaReady('http://127.0.0.1:11434', ctrl.signal, {
      auto_start: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctrl.abort();

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
