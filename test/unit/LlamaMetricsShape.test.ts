/**
 * The llama.cpp side of the Monitor: `llamaMetricsShape.ts` builds the document Strata's
 * page reads out of what Forge can see. The tests below are the shape contract — and the
 * rule it exists to keep: a card with no source stays absent, so the page hides it instead
 * of drawing a zero nobody measured.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildLlamaMetrics,
  createMetricsHistory,
  createRequestRing,
  HISTORY_LENGTH,
  REQUEST_RING_LENGTH,
  llamaLive,
  type MonitorRequestRow,
} from '../../src/monitor/llamaMetricsShape';
import {
  createRequestStatsReporter,
  subscribeRequestCaptures,
  type RequestCapture,
} from '../../src/sessions/requestStats';
import type { GpuInfo } from '../../src/system/systemProbes';

const GPU: GpuInfo[] = [
  {
    index: 0,
    name: 'NVIDIA GeForce RTX 5060 Ti',
    memoryUsedMb: 14633,
    memoryTotalMb: 16311,
    utilizationPercent: 37,
    temperatureC: 49,
    powerDrawW: 65.04,
    powerLimitW: 153,
    pcieGenCurrent: 3,
    pcieGenMax: 3,
    pcieWidthCurrent: 8,
  },
  {
    index: 1,
    name: 'NVIDIA GeForce RTX 3060',
    memoryUsedMb: 2529,
    memoryTotalMb: 12288,
    utilizationPercent: 2,
    temperatureC: 47,
    powerDrawW: 42.21,
    powerLimitW: 136,
    pcieGenCurrent: 3,
    pcieGenMax: 3,
    pcieWidthCurrent: 4,
  },
];

const SLOTS = {
  active: 1,
  total: 2,
  slots: [
    { used: 4096, size: 32768 },
    { used: 0, size: 32768 },
  ],
};

const PROMETHEUS = {
  'llamacpp:prompt_tokens_seconds': 610.5,
  'llamacpp:predicted_tokens_seconds': 42.25,
  'llamacpp:requests_processing': 1,
  'llamacpp:requests_deferred': 3,
};

/** A finished request as the transport reports it: server timings, usage, client clock. */
function capture(over: Partial<RequestCapture['stats']> = {}): RequestCapture {
  return {
    body: '{}',
    url: '/v1/chat/completions',
    model: 'test-model',
    sentAtMs: 1_795_519_920_000,
    stats: {
      outcome: 'ok',
      finishReason: 'stop',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 800 },
      },
      timings: {
        prompt_n: 200,
        prompt_ms: 400,
        cache_n: 800,
        predicted_n: 200,
        predicted_ms: 4000,
        draft_n: 40,
        draft_n_accepted: 30,
      },
      client: { ttfb_ms: 100, first_token_ms: 480, total_ms: 4500, chunks: 200 },
      ...over,
    },
  };
}

describe('llamaMetricsShape: the history ring', () => {
  it('keeps one sample per poll, oldest dropped past the cap', () => {
    const history = createMetricsHistory(3);
    for (const util of [10, 20, 30, 40]) history.push({ gpu_util: util });
    expect(history.snapshot()).toEqual({ gpu_util: [20, 30, 40] });
    expect(history.length()).toBe(4);
    expect(HISTORY_LENGTH).toBe(60);
  });

  it('never opens a series for a source that stays silent, and records a gap as null', () => {
    const history = createMetricsHistory();
    history.push({ gpu_util: 10, cpu: null });
    history.push({ gpu_util: 20, cpu: null });
    const snapshot = history.snapshot() as Record<string, unknown>;
    expect(snapshot.gpu_util).toEqual([10, 20]);
    expect(snapshot.cpu).toEqual([null, null]);
    // `gpu_power`, `disk_read_mb` and the rest were never offered: absent, not zero.
    expect('gpu_power' in snapshot).toBe(false);
    expect('disk_read_mb' in snapshot).toBe(false);
  });

  it('keeps every card series the same length when a card answers late or goes away', () => {
    const history = createMetricsHistory();
    history.push({
      gpus: [
        { index: 0, util: 10 },
        { index: 1, util: 5 },
      ],
    });
    // Card 1 stops reporting; card 2 (index 2) appears with a power reading.
    history.push({
      gpus: [
        { index: 0, util: 20 },
        { index: 2, power: 40 },
      ],
    });
    const gpus = (history.snapshot() as { gpus: Record<string, Record<string, number[]>> }).gpus;
    expect(gpus['0']).toEqual({ util: [10, 20] });
    expect(gpus['1']).toEqual({ util: [5, null] });
    // A series that starts late is backfilled, so the sparklines stay aligned.
    expect(gpus['2']).toEqual({ power: [null, 40] });
    expect('util' in gpus['2']).toBe(false);
  });

  it('Clear empties it', () => {
    const history = createMetricsHistory();
    history.push({ gpu_util: 10, gpus: [{ index: 0, util: 10 }] });
    history.reset();
    expect(history.snapshot()).toEqual({});
    expect(history.length()).toBe(0);
  });
});

describe('llamaMetricsShape: the request ring', () => {
  it('keeps as many rows as Strata does', () => {
    expect(REQUEST_RING_LENGTH).toBe(150);
  });

  it('maps a finished request onto the table row the page reads', () => {
    const ring = createRequestRing();
    ring.record(capture());
    const rows = ring.rows() as unknown as MonitorRequestRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 1,
      time: 1795519920,
      finish: 'stop',
      duration_s: 4.5,
      prompt_tokens: 1000,
      reused: 800,
      output_tokens: 200,
      prompt_ms: 400,
      decode_ms: 4000,
      decode_tok_s: 50,
      hit_rate: 0.8,
      first_engine_token_s: 0.48,
      drafts_offered: 40,
      drafts_accepted: 30,
    });
  });

  it('newest first, capped, and the totals are the sums of what is kept', () => {
    const ring = createRequestRing(2);
    ring.record(capture());
    ring.record(
      capture({
        outcome: 'error',
        finishReason: undefined,
        usage: { prompt_tokens: 10, completion_tokens: 1 },
        timings: { prompt_n: 10, prompt_ms: 5, predicted_n: 1, predicted_ms: 100 },
      }),
    );
    ring.record(capture({ client: { total_ms: 1000, chunks: 1 } }));
    const rows = ring.rows() as unknown as MonitorRequestRow[];
    expect(rows).toHaveLength(2);
    // The third request is the newest, and the first one fell out of the ring.
    expect(rows[0]?.finish).toBe('stop');
    expect(rows[1]?.finish).toBe('error');
    expect(ring.kept()).toBe(2);
    expect(ring.totals()).toEqual({
      since: expect.any(Number),
      requests: 2,
      prompt_tokens: 1010,
      reused: 800,
      output_tokens: 201,
      prompt_ms: 405,
      decode_ms: 4100,
      drafts_offered: 40,
      drafts_accepted: 30,
    });
  });

  it('an outcome with no finish word of its own still names one the table understands', () => {
    const ring = createRequestRing();
    for (const [outcome, finish] of [
      ['aborted', 'cancel'],
      ['truncated', 'length'],
      ['error', 'error'],
    ] as const) {
      ring.record(capture({ outcome, finishReason: undefined }));
    }
    expect((ring.rows() as unknown as MonitorRequestRow[]).map((row) => row.finish)).toEqual([
      'error',
      'length',
      'cancel',
    ]);
  });

  it('a provider that reports nothing leaves the row without those keys, not zeroed', () => {
    const ring = createRequestRing();
    ring.record({
      ...capture(),
      stats: { outcome: 'ok', client: { total_ms: 12, chunks: 3 } },
    });
    const row = ring.rows()[0] as unknown as Record<string, unknown>;
    expect(row).toEqual({ id: 1, time: 1795519920, finish: 'stop', duration_s: 0.012 });
  });

  it('Clear drops the rows, restarts the totals and says so', () => {
    let clock = 1_000_000;
    const ring = createRequestRing(5, () => clock);
    ring.record(capture());
    expect(ring.wasReset()).toBe(false);
    clock = 2_000_000;
    ring.reset();
    expect(ring.rows()).toEqual([]);
    expect(ring.kept()).toBe(0);
    expect(ring.wasReset()).toBe(true);
    expect(ring.totals().since).toBe(2000);
  });
});

describe('llamaMetricsShape: the live block', () => {
  it('reads slots and counters into Strata live keys', () => {
    expect(llamaLive(SLOTS, PROMETHEUS)).toEqual({
      state: 'generating',
      parallel: 2,
      running: 1,
      // `/slots` reports a slot's whole context, so the fill goes in as the prompt it read.
      prompt_tokens: 4096,
      generated: 0,
      queued: 3,
      tok_s: 42.25,
      prefill_tok_s_mean: 610.5,
    });
  });

  it('idle when no slot works, and absent when nothing answered', () => {
    expect(llamaLive({ ...SLOTS, active: 0 }, PROMETHEUS)?.state).toBe('idle');
    expect(llamaLive()).toBeUndefined();
  });
});

describe('llamaMetricsShape: the whole document', () => {
  const full = () => {
    const history = createMetricsHistory();
    history.push({ gpu_util: 20, gpu_mem_used: 1000, gpus: [{ index: 0, util: 20 }] });
    const requests = createRequestRing();
    requests.record(capture());
    return { history, requests };
  };

  it('carries every key the page reads, with memory in bytes', () => {
    const { history, requests } = full();
    const metrics = buildLlamaMetrics({
      model: 'test-model',
      slots: SLOTS,
      prometheus: PROMETHEUS,
      gpu: { gpus: GPU },
      cpu: { tempC: 61, powerW: 88.5 },
      cpuPercent: 12.5,
      ups: { values: { 'ups.status': 'OL', 'input.voltage': '230' } },
      forge: { today: { turns: 4 }, stale: false },
      history,
      requests,
    });
    expect(metrics.engine).toEqual({ model: 'test-model', max_context: 32768 });
    expect(metrics.live?.state).toBe('generating');
    const hardware = metrics.hardware as Record<string, unknown>;
    // nvidia-smi answers in MiB; the page divides by 1073741824, so bytes go out.
    expect((hardware.gpus as Record<string, unknown>[])[0]).toEqual({
      index: 0,
      name: 'NVIDIA GeForce RTX 5060 Ti',
      util: 37,
      mem_used: 14633 * 1048576,
      mem_total: 16311 * 1048576,
      temp: 49,
      power: 65.04,
      power_limit: 153,
      pcie_gen: 3,
      pcie_gen_max: 3,
      pcie_width: 8,
    });
    expect(hardware.gpu_util).toBeCloseTo(19.5);
    expect(hardware.gpu_mem_used).toBe((14633 + 2529) * 1048576);
    expect(hardware.gpu_temp).toBe(49);
    expect(hardware.gpu_power).toBeCloseTo(107.25);
    expect(hardware.cpu).toBe(12.5);
    expect(hardware.cpu_temp).toBe(61);
    expect(hardware.cpu_power).toBe(88.5);
    expect(hardware.ram_total).toBeGreaterThan(hardware.ram_used as number);
    // No disk counters here: absent, so the page says "needs psutil" rather than 0 MB/s.
    expect('disk_read_mb' in hardware).toBe(false);
    expect('measured_power' in hardware).toBe(false);
    const statics = metrics.hardware_static as Record<string, unknown>;
    expect(statics.os).toBe(process.platform === 'win32' ? 'windows' : process.platform);
    expect(statics.gpu_count).toBe(2);
    expect(statics.gpu_name).toBe('NVIDIA GeForce RTX 5060 Ti + NVIDIA GeForce RTX 3060');
    expect(statics.threads).toBeGreaterThan(0);
    expect(metrics.ups).toEqual({ 'ups.status': 'OL', 'input.voltage': '230' });
    expect(metrics.forge).toEqual({ today: { turns: 4 }, stale: false });
    expect(metrics.history).toEqual({
      gpu_util: [20],
      gpu_mem_used: [1000],
      gpus: { '0': { util: [20] } },
    });
    expect(metrics.requests_kept).toBe(1);
    expect(metrics.monitor_totals_reset).toBe(false);
    expect((metrics.requests as unknown[]).length).toBe(1);
    // llama.cpp has no conversation cache, no routed experts and no speculation: the page
    // hides those panels rather than being told they are empty.
    expect('conversation_cache' in metrics).toBe(false);
    expect('engine' in metrics).toBe(true);
    expect((metrics.engine as Record<string, unknown>).experts).toBeUndefined();
    expect((metrics.engine as Record<string, unknown>).spec).toBeUndefined();
  });

  it('a machine without nvidia-smi still gets the document, without the GPU keys', () => {
    const metrics = buildLlamaMetrics({
      model: 'test-model',
      slots: SLOTS,
      gpu: { gpus: [], error: 'nvidia-smi is not on PATH' },
    });
    const hardware = metrics.hardware as Record<string, unknown>;
    expect('gpus' in hardware).toBe(false);
    expect('gpu_util' in hardware).toBe(false);
    expect('gpu_mem_used' in hardware).toBe(false);
    expect('gpu_name' in (metrics.hardware_static as Record<string, unknown>)).toBe(false);
    // The readings that do not come from the probe are still there.
    expect(hardware.ram_total).toBeGreaterThan(0);
    expect(metrics.live?.state).toBe('generating');
  });

  it('a failing /slots keeps the readings that did answer and shows no live block', () => {
    const metrics = buildLlamaMetrics({
      model: 'test-model',
      engineError: '/slots answered HTTP 500',
      gpu: { gpus: GPU },
    });
    expect(metrics.error).toBeUndefined();
    expect('live' in metrics).toBe(false);
    expect((metrics.hardware as Record<string, unknown>).gpu_util).toBeDefined();
    // The gauge falls back to the configured context window.
    expect(buildLlamaMetrics({ model: 'm', contextLimit: 8192 }).engine).toEqual({
      model: 'm',
      max_context: 8192,
    });
  });

  it('nothing to show at all is an error the page can name', () => {
    expect(buildLlamaMetrics({ model: 'm', engineError: '/slots answered HTTP 500' })).toEqual({
      error: '/slots answered HTTP 500',
    });
  });

  it('an UPS that is not configured stays absent rather than an empty card', () => {
    const metrics = buildLlamaMetrics({ model: 'm', gpu: { gpus: GPU }, ups: { values: {} } });
    expect('ups' in metrics).toBe(false);
    expect('ups' in buildLlamaMetrics({ model: 'm', gpu: { gpus: GPU }, ups: null })).toBe(false);
  });
});

describe('the request bus every finished request reaches', () => {
  it('a finished request reaches a subscriber, and stops reaching it after unsubscribe', () => {
    const ring = createRequestRing();
    const seen: RequestCapture[] = [];
    const stop = subscribeRequestCaptures((captured) => {
      seen.push(captured);
      ring.record(captured);
    });
    // No `handler`: the Monitor reads the same rows the session log would write, and the
    // bus fires whether or not this call site has a writer.
    const reporter = createRequestStatsReporter({
      body: '{}',
      url: 'http://127.0.0.1:8080/v1/chat/completions',
      model: 'test-model',
      sentAtMs: 1_795_519_920_000,
      clientClock: {
        firstByte: () => undefined,
        firstToken: () => undefined,
        chunk: () => undefined,
        finish: () => ({ total_ms: 4500, chunks: 20, first_token_ms: 480 }),
      },
      onCallbackError: () => undefined,
    });
    reporter.setUsage({ prompt_tokens: 1000, completion_tokens: 200 });
    reporter.setTimings({ prompt_n: 200, prompt_ms: 400, predicted_n: 200, predicted_ms: 4000 });
    reporter.complete('stop');
    expect(seen).toHaveLength(1);
    const rows = ring.rows() as unknown as MonitorRequestRow[];
    expect(rows[0]).toMatchObject({
      finish: 'stop',
      prompt_tokens: 1000,
      output_tokens: 200,
      decode_tok_s: 50,
    });
    stop();
    const second = createRequestStatsReporter({
      body: '{}',
      url: 'http://127.0.0.1:8080/v1/chat/completions',
      model: 'test-model',
      sentAtMs: 1_795_519_921_000,
      clientClock: {
        firstByte: () => undefined,
        firstToken: () => undefined,
        chunk: () => undefined,
        finish: () => ({ total_ms: 10, chunks: 1 }),
      },
      onCallbackError: () => undefined,
    });
    second.complete('stop');
    expect(seen).toHaveLength(1);
    expect(ring.kept()).toBe(1);
  });
});
