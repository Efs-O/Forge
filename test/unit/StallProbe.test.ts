import { describe, expect, it, vi } from 'vitest';
import { createStallProbe } from '../../src/llm/stallProbe';

describe('stallProbe', () => {
  it('returns alive for a processing slot without reading the status endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([{ is_processing: true }])));
    const answer = await createStallProbe('http://127.0.0.1:8080', fetcher as typeof fetch)(new AbortController().signal);
    expect(answer).toBe('alive');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8080/slots');
  });

  it('uses generated progress, never the stale phase field, for the status fallback', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ busy: true, generated: 3, phase: 'idle' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ busy: true, generated: 4, phase: 'idle' })));
    const wait = vi.fn(async () => {});
    const answer = await createStallProbe('http://localhost:8080', fetcher as typeof fetch, wait)(new AbortController().signal);
    expect(answer).toBe('alive');
    expect(wait).toHaveBeenCalledWith(2_000);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:8080/slots',
      'http://localhost:8080/v1/status',
      'http://localhost:8080/v1/status',
    ]);
  });

  it('does not probe a cloud origin', async () => {
    const fetcher = vi.fn();
    const answer = await createStallProbe('https://api.example.com/v1', fetcher as typeof fetch)(new AbortController().signal);
    expect(answer).toBe('skipped: not loopback');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
