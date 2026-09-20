import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeHttp, waitForHealthy } from '../../src/backend/HealthCheck';

afterEach(() => {
  vi.unstubAllGlobals();
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
});
