// @vitest-environment jsdom
/**
 * The vendored Strata Monitor page, rendered. What the page *shows* is the part no unit
 * test can reach: which cards appear, which hide because nothing fed them, the context
 * gauge, the request table, the Forge header, and what the Clear button asks the host for.
 *
 * The page is run as it ships — the vendored `monitor.js` verbatim against the panel's own
 * markup — and fed the two documents the host can send: Strata's, and the one
 * `llamaMetricsShape.ts` builds for a llama.cpp engine.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLlamaMetrics,
  createMetricsHistory,
  createRequestRing,
} from '../../src/monitor/llamaMetricsShape';
import type { MetricsDocument } from '../../src/monitor/monitorTypes';
import type { GpuInfo } from '../../src/system/systemProbes';

const ROOT = path.resolve(__dirname, '..', '..');
const VENDOR = path.join(ROOT, 'webview-ui', 'vendor', 'strata-monitor');

function panelMarkup(): string {
  const html = readFileSync(path.join(ROOT, 'webview-ui', 'monitor.html'), 'utf8');
  return html
    .replace('${sprite}', () => readFileSync(path.join(VENDOR, 'sprite.svg'), 'utf8'))
    .replace(/\$\{(nonce|cssUri|jsUri|themeKind|cspSource)\}/g, () => 'x')
    .replace(/<script nonce="x" src="x"><\/script>/, '')
    .replace(/^[\s\S]*?<body>/, '')
    .replace(/<\/body>[\s\S]*$/, '');
}

/** Run the vendored page against the panel markup, with the host bridge it expects. */
function loadPage(): { sent: unknown[]; run: (metrics: MetricsDocument) => void } {
  const sent: unknown[] = [];
  const state: Record<string, unknown> = {};
  vi.stubGlobal('acquireVsCodeApi', () => ({
    getState: () => state,
    setState: (next: Record<string, unknown>) => {
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, next);
    },
    postMessage: (message: unknown) => {
      sent.push(message);
      return true;
    },
  }));
  document.documentElement.innerHTML = `<head></head><body>${panelMarkup()}</body>`;
  // The page is a script, run exactly as the panel loads it.
  new Function(readFileSync(path.join(VENDOR, 'monitor.js'), 'utf8'))();
  return {
    sent,
    run: (metrics) => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'monitorMetrics', metrics } }),
      );
    },
  };
}

const text = (id: string): string => document.getElementById(id)?.textContent ?? '';
const card = (key: string): HTMLElement =>
  document.querySelector(`[data-card-key="${key}"]`) as HTMLElement;
const oneDecimal = (value: number): string =>
  value.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 });

const GPU: GpuInfo[] = [
  {
    index: 0,
    name: 'NVIDIA GeForce RTX 5060 Ti',
    memoryUsedMb: 14633,
    memoryTotalMb: 16311,
    utilizationPercent: 37,
    temperatureC: 49,
    powerDrawW: 65,
    powerLimitW: 153,
    pcieGenCurrent: 3,
    pcieGenMax: 3,
    pcieWidthCurrent: 8,
  },
];

/** A Strata reading, the way the server answers it. */
const STRATA_DOCUMENT: MetricsDocument = {
  engine: { model: 'strata-demo', max_context: 262144, spec: 7, expert_slots: 128 },
  live: {
    state: 'generating',
    queued: 0,
    prompt_tokens: 100000,
    generated: 500,
    max_tokens: 4096,
    tok_s: 42.5,
    prefill_tok_s_mean: 610,
  },
  requests: [
    {
      time: 1795519920,
      finish: 'stop',
      prompt_tokens: 1000,
      reused: 800,
      output_tokens: 200,
      prompt_ms: 400,
      decode_tok_s: 42.5,
      duration_s: 5,
      hit_rate: 0.8,
      drafts_offered: 40,
      drafts_accepted: 30,
    },
  ],
  requests_kept: 1,
  conversation_cache: { enabled: true, budget_mib: 2048, slots: 2, parked: 1 },
  totals: {
    since: 1795519000,
    requests: 1,
    prompt_tokens: 1000,
    reused: 800,
    output_tokens: 200,
    prompt_ms: 400,
    decode_ms: 4700,
    drafts_offered: 40,
    drafts_accepted: 30,
  },
  hardware: {
    gpu_util: 37,
    gpu_mem_used: 14633 * 1048576,
    gpu_mem_total: 16311 * 1048576,
    gpu_temp: 49,
    gpu_power: 65,
    gpu_power_limit: 153,
    gpu_pcie_gen_max: 3,
    gpu_pcie_width: 8,
    cpu: 12,
    cpu_temp: 61,
    ram_used: 20 * 1073741824,
    ram_total: 32 * 1073741824,
    disk_read_mb: 12.5,
    gpus: [{ index: 0, util: 37, mem_used: 14633 * 1048576, mem_total: 16311 * 1048576 }],
  },
  hardware_static: { os: 'windows', gpu_name: 'RTX 5060 Ti', gpu_count: 1, threads: 16 },
  history: { gpu_util: [10, 20, 37], tok_s: [40, 41, 42] },
  forge: { today: { turns: 4, tool_calls: 10, tool_failures: 1 } },
  ups: { 'ups.status': 'OL', 'input.voltage': '230' },
};

/** The same page fed by Forge's own readings for a llama.cpp engine. */
function llamaDocument(): MetricsDocument {
  const history = createMetricsHistory();
  history.push({ gpu_util: 20, gpu_mem_used: 1000, gpus: [{ index: 0, util: 20 }] });
  history.push({ gpu_util: 37, gpu_mem_used: 1200, gpus: [{ index: 0, util: 37 }] });
  const requests = createRequestRing();
  requests.record({
    body: '{}',
    url: '/v1/chat/completions',
    model: 'llama-demo',
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
      },
      client: { total_ms: 4500, chunks: 200, first_token_ms: 480 },
    },
  });
  return buildLlamaMetrics({
    model: 'llama-demo',
    slots: { active: 1, total: 2, slots: [{ used: 4096, size: 32768 }] },
    prometheus: {
      'llamacpp:prompt_tokens_seconds': 610,
      'llamacpp:predicted_tokens_seconds': 42,
      'llamacpp:requests_deferred': 0,
    },
    gpu: { gpus: GPU },
    cpu: { tempC: 61, powerW: 88 },
    cpuPercent: 12,
    ups: { values: { 'ups.status': 'OL', 'input.voltage': '230' } },
    forge: { today: { turns: 4 } },
    history,
    requests,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = '';
});

describe('the vendored Monitor page', () => {
  it('asks the host for the first reading, and carries the Forge header', () => {
    const { sent } = loadPage();
    expect(sent).toEqual([{ type: 'ready' }]);
    expect(document.querySelector('.st-header__brand')?.textContent).toBe('Forge');
    expect(document.querySelector('.forge-header__mark')).not.toBeNull();
    expect(document.querySelector('.monitor-credit')?.textContent).toBe(
      'Monitor page from Strata (github.com/Niko1221/Strata), MIT License.',
    );
  });

  it('shows the cards, gauge, table and cache panel a Strata engine reports', () => {
    const page = loadPage();
    page.run(STRATA_DOCUMENT);
    expect(text('state-label')).toBe('Generating');
    // Locale-independent: this machine formats 14.3 as "14,3", so check the shape.
    expect(text('mv-vram')).toMatch(/^14/);
    expect(text('ctx-pct')).toBe('38%');
    expect(text('slots-text')).toContain('128');
    expect(document.querySelectorAll('#req-body tr')).toHaveLength(1);
    expect(text('req-totals')).toContain('requests');
    expect(document.getElementById('cc-card')?.hidden).toBe(false);
    expect(card('speculation')?.hidden).toBe(false);
    expect(card('ups')?.hidden).toBe(false);
    expect(card('disk')?.hidden).toBe(false);
    expect(text('mv-disk')).toMatch(/^1[23]/);
    expect(text('sv-speculation')).toBe(`${oneDecimal(75)}%`);
    expect(text('ss-speculation')).toBe(`since start ${oneDecimal(75)}%`);
    expect(document.querySelector('#req-body td[title="30 accepted / 40 offered"]')?.textContent).toBe(`${oneDecimal(75)}%`);
  });

  it('labels batch drafts per run and shows the last run rate', () => {
    const page = loadPage();
    const parallelDocument: MetricsDocument = {
      ...STRATA_DOCUMENT,
      requests: [{ ...(STRATA_DOCUMENT.requests?.[0] as Record<string, unknown>), batch_slot: true,
        drafts_offered: null, drafts_accepted: null }],
      totals: { ...STRATA_DOCUMENT.totals, requests: 2, drafts_offered: 1402, drafts_accepted: 893 },
      batch_drafts: { last: { accepted: 773, offered: 1202, at: 1795519930 }, runs: 2, accepted: 893, offered: 1402 },
    };
    page.run(parallelDocument);
    expect(text('sv-speculation')).toBe(`${oneDecimal((773 / 1202) * 100)}%`);
    expect(text('ss-speculation')).toBe(`parallel run · since start ${oneDecimal((893 / 1402) * 100)}%`);
    expect(document.querySelector('#req-body td[title="Drafts in parallel runs are counted per run, not per request: see the Speculation card."]')?.textContent).toBe('parallel');
  });

  it('keeps an unreported solo request draft cell as a dash', () => {
    const page = loadPage();
    page.run({
      ...STRATA_DOCUMENT,
      requests: [{ ...(STRATA_DOCUMENT.requests?.[0] as Record<string, unknown>), batch_slot: false,
        drafts_offered: null, drafts_accepted: null }],
    });
    expect(document.querySelector('#req-body td[title="No draft tokens offered"]')?.textContent).toBe('–');
  });

  it('a llama.cpp reading fills what Forge can measure and hides what it cannot', () => {
    const page = loadPage();
    page.run(llamaDocument());
    // The state sentence follows the engine's own live state; the gauge reads /slots.
    expect(text('state-label')).toBe('Generating');
    expect(text('ctx-pct')).toBe('13%');
    expect(text('ctx-sub')).toMatch(/^4[.,]?1k \/ 32K$/);
    // Speed, GPU, VRAM, temperature, power, CPU and UPS all have a source here.
    for (const key of ['speed', 'gpu', 'vram', 'vram-free', 'temp', 'power', 'pcie', 'cpu', 'session', 'forge', 'ups']) {
      expect(card(key)?.hidden, `${key} card`).toBe(false);
    }
    expect(text('mv-vram')).toMatch(/^14/);
    expect(text('mv-temp')).toContain('49');
    expect(text('mv-cpu')).toContain('12');
    expect(text('sv-ups')).toMatch(/On line|OL/);
    expect(text('cpu-temp-text')).toContain('61');
    // The request table comes from Forge's own finished requests.
    expect(document.querySelectorAll('#req-body tr')).toHaveLength(1);
    expect(document.querySelector('#req-body tr')?.textContent).toContain('Done');
    expect(text('req-totals')).toContain('Since');
    // Nothing was invented for what llama.cpp does not report: experts, speculation, the
    // conversation cache and the disk counters are hidden, not zeroed.
    expect(card('speculation')?.hidden).toBe(true);
    expect(card('disk')?.hidden).toBe(true);
    expect(document.getElementById('cc-card')?.hidden).toBe(true);
    expect(text('slots-text')).toBe('–');
    expect(text('mv-disk')).toBe('–');
  });

  it('Clear hides the rows shown, asks the host to reset the totals, and says when it failed', () => {
    const page = loadPage();
    page.run(llamaDocument());
    (document.getElementById('req-clear') as HTMLElement).click();
    expect(page.sent.at(-1)).toEqual({ type: 'monitorClear' });
    expect(document.querySelector('#req-body tr')?.textContent).toContain('Cleared');
    // The host answers the next reading with the refusal; the page says it, not swallows it.
    page.run({ ...llamaDocument(), clear_error: 'The server answered 500: nope' });
    expect(text('req-totals')).toContain('totals not reset: The server answered 500: nope');
  });
});
