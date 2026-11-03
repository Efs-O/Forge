import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { startAdoptedServerMonitor } from '../../src/backend/adoptedServerMonitor';

/** What a live llama-server answers: `/health` 200 "OK", `/slots` the JSON array. */
const healthOk = (): Response => new Response('OK', { status: 200 });
const slotsOk = (slots: unknown[] = [{ state: 1, n_past: 128, n_ctx: 8192 }]): Response =>
  new Response(JSON.stringify(slots), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** The rejection `AbortSignal.timeout` really produces: a TimeoutError, not a
 *  generic Error — `/slots` sits on the server's main loop and can miss the
 *  bound while the server is alive, which is the whole point of this file. */
const timedOut = (): Promise<never> => {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return Promise.reject(error);
};
const refused = (): Promise<never> => Promise.reject(new Error('connect ECONNREFUSED'));

const POLL_MS = 100;

interface Harness {
  ticks: (n: number) => Promise<void>;
  lost: number;
  lines: string[];
}

function harness(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): Harness {
  const state = { lost: 0, lines: [] as string[] };
  const timer = startAdoptedServerMonitor({
    baseUrl: 'http://127.0.0.1:8082',
    log: (line) => state.lines.push(line),
    onLost: () => {
      state.lost += 1;
    },
    fetchImpl: fetchImpl as typeof fetch,
    pollIntervalMs: POLL_MS,
    probeTimeoutMs: 50,
  });
  clearIntervalOnExit(timer);
  return {
    ticks: async (n: number) => {
      for (let index = 0; index < n; index++) await vi.advanceTimersByTimeAsync(POLL_MS);
    },
    get lost() {
      return state.lost;
    },
    get lines() {
      return state.lines;
    },
  };
}

const timers: ReturnType<typeof setInterval>[] = [];
function clearIntervalOnExit(timer: ReturnType<typeof setInterval>): void {
  timers.push(timer);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
  vi.useRealTimers();
});

describe('adopted llama-server monitor (BL-013)', () => {
  it('does not call a busy server gone when only /slots misses the bound', async () => {
    // The regression this exists for: `/slots` waits on the server's main loop,
    // so a long prompt read misses the probe timeout while `/health` answers.
    const h = harness(async (url) => (url.endsWith('/slots') ? timedOut() : healthOk()));
    await h.ticks(4);
    expect(h.lost).toBe(0);
    expect(h.lines.join('\n')).toContain('llama-server healthy');
    expect(h.lines.join('\n')).toContain('slots: busy, no answer within 50 ms');
  });

  it('calls the server gone only after /health misses twice in a row', async () => {
    const h = harness(async (url) => (url.endsWith('/slots') ? slotsOk() : refused()));
    await h.ticks(1);
    expect(h.lost).toBe(0);
    expect(h.lines.join('\n')).toContain('checking again before calling it gone');
    await h.ticks(1);
    expect(h.lost).toBe(1);
    expect(h.lines.join('\n')).toContain('llama-server stopped or unreachable');
  });

  it('lets an answer between two misses reset the count, so a stall is not a death', async () => {
    let calls = 0;
    const h = harness(async (url) => {
      if (url.endsWith('/slots')) return slotsOk();
      calls += 1;
      return calls % 2 === 1 ? refused() : healthOk();
    });
    await h.ticks(4);
    expect(h.lost).toBe(0);
  });

  it('reports a death once, even though the interval keeps running until the caller clears it', async () => {
    const h = harness(async (url) => (url.endsWith('/slots') ? slotsOk() : refused()));
    await h.ticks(5);
    expect(h.lost).toBe(1);
  });

  it('still shows the slot and context line a healthy server answers', async () => {
    const h = harness(async (url) => (url.endsWith('/slots') ? slotsOk() : healthOk()));
    await h.ticks(1);
    expect(h.lines.join('\n')).toContain('slots: 1/1 active | 128/8192 ctx');
  });

  it('says nothing about slots on a server that never offers /slots (--no-slots)', async () => {
    const h = harness(async (url) =>
      url.endsWith('/slots')
        ? new Response('This server was not created with --no-slots', { status: 501 })
        : healthOk(),
    );
    await h.ticks(2);
    const lines = h.lines.join('\n');
    expect(lines).toContain('llama-server healthy');
    expect(lines).not.toContain('501');
    expect(lines).not.toContain('busy');
    expect(h.lost).toBe(0);
  });
});
