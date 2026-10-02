import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeHttp, waitForHealthy } from '../../src/backend/HealthCheck';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('HealthCheck', () => {
  it('distinguishes a reachable non-llama HTTP service from an unreachable port', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('File not found', { status: 404, statusText: 'Not Found' })),
    );

    await expect(probeHttp('http://127.0.0.1:8080')).resolves.toEqual({
      reachable: true,
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
  });

  it('reports an HTTP error instead of waiting for the full startup timeout', async () => {
    const fetchMock = vi.fn(
      async () => new Response('File not found', { status: 404, statusText: 'Not Found' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      waitForHealthy({ baseUrl: 'http://127.0.0.1:8080', intervalMs: 1_000, timeoutMs: 60_000 }),
    ).resolves.toEqual({
      ok: false,
      reason: 'error',
      message: 'http://127.0.0.1:8080/v1/models returned HTTP 404 Not Found',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while llama-server returns a temporary 5xx response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('warming', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"data":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      waitForHealthy({ baseUrl: 'http://127.0.0.1:8080', intervalMs: 1, timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails immediately on an already-aborted signal instead of polling to the timeout', async () => {
    // Reached for real from `ensureOllamaReady`: an abort during one launch
    // candidate breaks out of the candidate loop and then calls this a final
    // time on the same dead signal. The abort listener can never fire again, so
    // the poll used to run the full 10 s and report "did not become reachable"
    // to a user who had pressed Stop.
    const fetchMock = vi.fn(async () => new Response('{"data":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = new AbortController();
    ctrl.abort();

    const startedAt = Date.now();
    await expect(
      waitForHealthy(
        { baseUrl: 'http://127.0.0.1:8080', intervalMs: 10, timeoutMs: 60_000 },
        undefined,
        ctrl.signal,
      ),
    ).resolves.toEqual({ ok: false, reason: 'aborted', message: 'Aborted' });
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops polling and removes its listener when the signal aborts mid-wait', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = new AbortController();

    const pending = waitForHealthy(
      { baseUrl: 'http://127.0.0.1:8080', intervalMs: 5, timeoutMs: 60_000 },
      undefined,
      ctrl.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctrl.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'aborted', message: 'Aborted' });

    // A second abort must not resurrect the settled check: the listener is
    // removed in `done`, so nothing re-fires.
    const pollsAfter = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock.mock.calls.length).toBe(pollsAfter);
  });

  it('keeps only one bounded health probe in flight', async () => {
    vi.useFakeTimers();
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const pendingSignals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const probeSignal = init?.signal as AbortSignal;
      pendingSignals.push(probeSignal);
      return new Promise<Response>((_resolve, reject) => {
        probeSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();
    const waiting = waitForHealthy({ baseUrl: 'http://127.0.0.1:8080', intervalMs: 50, timeoutMs: 60_000 }, undefined, caller.signal);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(2_000);
    timeout.abort();
    await vi.advanceTimersByTimeAsync(50);
    expect(pendingSignals[0]?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    caller.abort();
    await expect(waiting).resolves.toMatchObject({ ok: false, reason: 'aborted' });
  });
});
