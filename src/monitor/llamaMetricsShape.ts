/**
 * The Monitor document for a llama.cpp engine.
 *
 * The Monitor page is Strata's (vendored under `webview-ui/vendor/strata-monitor/`), so
 * every engine has to hand it the same document. A Strata server answers
 * `GET /metrics` itself; a llama.cpp server does not, so this module builds that document
 * from what Forge can read: llama-server's `/slots` and `/metrics`, the `nvidia-smi`
 * probe, LibreHardwareMonitor's CPU sensors, the NUT UPS client, Forge's own control
 * stats, and Forge's own finished requests.
 *
 * **The rule that shapes every key here: a value with no source stays absent.** A zero
 * that was never measured would read as "the GPU is idle" or "no VRAM free" and be
 * indistinguishable from the truth, so the page hides the card instead. `null` inside a
 * history series is different and deliberate: it is a gap at a known position, which is
 * what the sparkline draws.
 */
import * as os from 'os';
import type { ControlStats } from '../backend/controlStats';
import {
  requestStatsRow,
  type RequestCapture,
  type RequestOutcome,
} from '../sessions/requestStats';
import type { GpuInfo } from '../system/systemProbes';
import type {
  CpuStats,
  GpuProbeResult,
  MetricsDocument,
  SlotStats,
  UpsStats,
} from './monitorTypes';

/** Strata keeps 60 samples of every history series (`serve/telemetry.py`: `HISTORY = 60`);
 *  its sparklines are drawn for that many points. */
export const HISTORY_LENGTH = 60;
/** Strata keeps this many finished requests for the table and for "Show all"; Forge keeps
 *  the ones it made since the panel opened. */
export const REQUEST_RING_LENGTH = 150;

const MIB = 1048576;

type Numeric = number | null;

/** One card's readings in a history sample, in Strata's per-card key names. */
export interface HistoryGpuSample {
  index: number;
  util?: Numeric | undefined;
  mem_used?: Numeric | undefined;
  temp?: Numeric | undefined;
  power?: Numeric | undefined;
  pcie_rx_mb?: Numeric | undefined;
}

/** One poll's readings, in Strata's history series names. A key left `undefined` never
 *  opens a series; a key set to `null` records a gap. */
export interface HistorySample {
  gpu_util?: Numeric | undefined;
  gpu_mem_used?: Numeric | undefined;
  gpu_temp?: Numeric | undefined;
  gpu_power?: Numeric | undefined;
  gpu_pcie_rx_mb?: Numeric | undefined;
  gpu_pcie_tx_mb?: Numeric | undefined;
  cpu?: Numeric | undefined;
  ram_used?: Numeric | undefined;
  disk_read_mb?: Numeric | undefined;
  tok_s?: Numeric | undefined;
  prefill_tok_s_mean?: Numeric | undefined;
  all_gpu_power?: Numeric | undefined;
  cpu_temp?: Numeric | undefined;
  cpu_power?: Numeric | undefined;
  measured_power?: Numeric | undefined;
  gpus?: HistoryGpuSample[] | undefined;
}

export interface MetricsHistory {
  push(sample: HistorySample): void;
  /** Strata's `history` key: every series that has a source, oldest first. */
  snapshot(): Record<string, unknown>;
  /** Forget every sample — the Monitor's Clear starts the graphs again. */
  reset(): void;
  length(): number;
}

const SERIES_KEYS = [
  'gpu_util',
  'gpu_mem_used',
  'gpu_temp',
  'gpu_power',
  'gpu_pcie_rx_mb',
  'gpu_pcie_tx_mb',
  'cpu',
  'ram_used',
  'disk_read_mb',
  'tok_s',
  'prefill_tok_s_mean',
  'all_gpu_power',
  'cpu_temp',
  'cpu_power',
  'measured_power',
] as const;

const GPU_SERIES_KEYS = ['util', 'mem_used', 'temp', 'power', 'pcie_rx_mb'] as const;

/**
 * The host's side of Strata's history ring: one sample per poll, oldest dropped past
 * `cap`. It lives in memory only — a panel that is hidden stops polling, and a panel that
 * is disposed loses the ring with it (see the plan's lifecycle ledger).
 */
export function createMetricsHistory(cap: number = HISTORY_LENGTH): MetricsHistory {
  const series = new Map<string, Numeric[]>();
  const perGpu = new Map<string, Map<string, Numeric[]>>();
  let samples = 0;

  const append = (list: Numeric[], value: Numeric): void => {
    list.push(value);
    if (list.length > cap) list.splice(0, list.length - cap);
  };
  /** A series that starts late is backfilled with gaps so every series in one document
   *  stays the same length: the sparkline draws by index. */
  const openSeries = (): Numeric[] => {
    const list: Numeric[] = [];
    for (let i = Math.min(cap, samples) - 1; i > 0; i--) list.push(null);
    return list;
  };

  return {
    push(sample: HistorySample): void {
      samples += 1;
      for (const key of SERIES_KEYS) {
        const value = sample[key];
        if (value === undefined) continue;
        let list = series.get(key);
        if (!list) {
          list = openSeries();
          series.set(key, list);
        }
        append(list, value);
      }
      const seen = new Set<string>();
      for (const gpu of sample.gpus ?? []) {
        const index = String(gpu.index);
        seen.add(index);
        let card = perGpu.get(index);
        if (!card) {
          card = new Map();
          perGpu.set(index, card);
        }
        for (const key of GPU_SERIES_KEYS) {
          const value = gpu[key];
          let list = card.get(key);
          if (!list) {
            // A card never says `util` at all (a driver that will not answer) opens no
            // series, so the card draws nothing instead of a flat line of zeros.
            if (value === undefined || value === null) continue;
            list = openSeries();
            card.set(key, list);
          }
          append(list, value ?? null);
        }
      }
      // A card that vanished between polls keeps its place rather than shifting the rest.
      for (const [index, card] of perGpu) {
        if (seen.has(index)) continue;
        for (const list of card.values()) append(list, null);
      }
    },
    snapshot(): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const [key, list] of series) out[key] = [...list];
      if (perGpu.size) {
        const gpus: Record<string, Record<string, Numeric[]>> = {};
        for (const [index, card] of perGpu) {
          gpus[index] = Object.fromEntries([...card].map(([key, list]) => [key, [...list]]));
        }
        out.gpus = gpus;
      }
      return out;
    },
    reset(): void {
      series.clear();
      perGpu.clear();
      samples = 0;
    },
    length: () => samples,
  };
}

/** One row of the page's Recent requests table, in Strata's key names. */
export interface MonitorRequestRow {
  id: number;
  /** Seconds since the epoch, as Strata's `time`. */
  time: number;
  /** One of Strata's table words: stop, length, cancel, disconnect, error, timeout. */
  finish: string;
  duration_s?: number;
  prompt_tokens?: number;
  reused?: number;
  output_tokens?: number;
  prompt_ms?: number;
  decode_ms?: number;
  decode_tok_s?: number;
  hit_rate?: number;
  first_engine_token_s?: number;
  drafts_offered?: number;
  drafts_accepted?: number;
}

/** Strata's own words for how a request ended; anything the engine reports that is not
 *  one of these falls back to the outcome mapping below. */
const FINISH_WORDS = new Set(['stop', 'length', 'cancel', 'disconnect', 'error', 'timeout']);

const FINISH_BY_OUTCOME: Record<RequestOutcome, string> = {
  ok: 'stop',
  error: 'error',
  aborted: 'cancel',
  truncated: 'length',
};

export interface RequestRing {
  record(capture: RequestCapture): void;
  /** Newest first, which is how Strata orders `requests` (its `requests[0]` is the last). */
  rows(): MonitorRequestRow[];
  kept(): number;
  /** The `totals` block: sums over the kept rows, since this ring opened or was cleared. */
  totals(): Record<string, unknown>;
  /** Forget the rows and start the totals again — the Monitor's Clear. */
  reset(): void;
  /** True once Clear has run, so the page can label the totals "since clear". */
  wasReset(): boolean;
}

const round = (value: number, digits: number): number =>
  Number(value.toFixed(digits)) || Number(value.toFixed(digits));

/**
 * Forge's own finished requests, kept in memory for the page's table and its totals.
 *
 * `requestStatsRow` does the provider key mapping rather than a table of our own: it is
 * the same mapping the session log's `request_stats` rows use, so a provider that changes
 * what it reports changes here and there in one place.
 */
export function createRequestRing(
  cap: number = REQUEST_RING_LENGTH,
  now: () => number = () => Date.now(),
): RequestRing {
  const rows: MonitorRequestRow[] = [];
  let nextId = 1;
  let sinceSeconds = now() / 1000;
  let cleared = false;

  return {
    record(capture: RequestCapture): void {
      const stats = requestStatsRow(capture.stats, capture.model, capture.sentAtMs);
      const server = stats.server;
      const prompt =
        stats.prompt_tokens ??
        (server?.prompt_n !== undefined ? server.prompt_n + (server.cache_n ?? 0) : undefined);
      const reused = stats.cached_tokens ?? server?.cache_n;
      const output = stats.completion_tokens ?? server?.predicted_n;
      const promptMs = server?.prompt_ms;
      const decodeMs = server?.predicted_ms;
      const entry: MonitorRequestRow = {
        id: nextId++,
        time: stats.timestamp_ms / 1000,
        finish:
          stats.finish_reason && FINISH_WORDS.has(stats.finish_reason)
            ? stats.finish_reason
            : FINISH_BY_OUTCOME[stats.outcome],
        ...(stats.client.total_ms !== undefined
          ? { duration_s: round(stats.client.total_ms / 1000, 3) }
          : {}),
        ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
        ...(reused !== undefined ? { reused } : {}),
        ...(output !== undefined ? { output_tokens: output } : {}),
        ...(promptMs !== undefined ? { prompt_ms: promptMs } : {}),
        ...(decodeMs !== undefined ? { decode_ms: decodeMs } : {}),
        ...(decodeMs && output ? { decode_tok_s: round((output / decodeMs) * 1000, 3) } : {}),
        ...(prompt && reused !== undefined ? { hit_rate: round(reused / prompt, 4) } : {}),
        ...(stats.client.first_token_ms !== undefined
          ? { first_engine_token_s: round(stats.client.first_token_ms / 1000, 3) }
          : {}),
        ...(server?.draft_n !== undefined ? { drafts_offered: server.draft_n } : {}),
        ...(server?.draft_n_accepted !== undefined
          ? { drafts_accepted: server.draft_n_accepted }
          : {}),
      };
      rows.push(entry);
      if (rows.length > cap) rows.splice(0, rows.length - cap);
    },
    rows(): MonitorRequestRow[] {
      const copy = [...rows];
      copy.reverse();
      return copy;
    },
    kept: () => rows.length,
    totals(): Record<string, unknown> {
      const sum = (value: (row: MonitorRequestRow) => number): number =>
        rows.reduce((total, row) => total + (value(row) || 0), 0);
      return {
        since: sinceSeconds,
        requests: rows.length,
        prompt_tokens: sum((row) => row.prompt_tokens ?? 0),
        reused: sum((row) => row.reused ?? 0),
        output_tokens: sum((row) => row.output_tokens ?? 0),
        prompt_ms: sum((row) => row.prompt_ms ?? 0),
        decode_ms: sum((row) => row.decode_ms ?? 0),
        drafts_offered: sum((row) => row.drafts_offered ?? 0),
        drafts_accepted: sum((row) => row.drafts_accepted ?? 0),
      };
    },
    reset(): void {
      rows.length = 0;
      sinceSeconds = now() / 1000;
      cleared = true;
    },
    wasReset: () => cleared,
  };
}

/** Assign only what is known: an absent key is the page's cue to hide the card. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = value;
}

const finiteValues = (values: readonly (Numeric | undefined)[]): number[] =>
  values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

const sumOf = (values: readonly (Numeric | undefined)[]): number | undefined => {
  const kept = finiteValues(values);
  return kept.length ? kept.reduce((total, value) => total + value, 0) : undefined;
};

const maxOf = (values: readonly (Numeric | undefined)[]): number | undefined => {
  const kept = finiteValues(values);
  return kept.length ? Math.max(...kept) : undefined;
};

const meanOf = (values: readonly (Numeric | undefined)[]): number | undefined => {
  const sum = sumOf(values);
  return sum === undefined ? undefined : sum / finiteValues(values).length;
};

const firstOf = (values: readonly (Numeric | undefined)[]): number | undefined =>
  finiteValues(values)[0];

const mebibytesToBytes = (mib: Numeric | undefined): number | undefined =>
  mib === undefined || mib === null ? undefined : mib * MIB;

/** Strata's per-card row; `pcie_rx_mb` and `pcie_tx_mb` have no source in `nvidia-smi`
 *  and stay absent, which is what makes the page fall back to its aggregate wording. */
function gpuRow(gpu: GpuInfo): Record<string, unknown> {
  const row: Record<string, unknown> = { index: gpu.index, name: gpu.name };
  put(row, 'util', gpu.utilizationPercent);
  put(row, 'mem_used', mebibytesToBytes(gpu.memoryUsedMb));
  put(row, 'mem_total', mebibytesToBytes(gpu.memoryTotalMb));
  put(row, 'temp', gpu.temperatureC);
  put(row, 'power', gpu.powerDrawW);
  put(row, 'power_limit', gpu.powerLimitW);
  put(row, 'pcie_gen', gpu.pcieGenCurrent);
  put(row, 'pcie_gen_max', gpu.pcieGenMax);
  put(row, 'pcie_width', gpu.pcieWidthCurrent);
  return row;
}

/**
 * Strata's `live` block. llama-server's `/slots` reports each slot's whole context
 * (`n_past`) rather than a prompt and a completion, so the fill goes in as the prompt the
 * slot has read and the gauge is right for the running request either way.
 */
export function llamaLive(
  slots?: SlotStats,
  prometheus?: Record<string, number>,
): Record<string, unknown> | undefined {
  if (!slots && !prometheus) return undefined;
  const live: Record<string, unknown> = {};
  if (slots) {
    live.state = slots.active > 0 ? 'generating' : 'idle';
    live.parallel = slots.total;
    live.running = slots.active;
    const used = sumOf(slots.slots.map((slot) => slot.used));
    if (used !== undefined) {
      live.prompt_tokens = used;
      live.generated = 0;
    }
  }
  put(live, 'queued', prometheus?.['llamacpp:requests_deferred']);
  put(live, 'tok_s', prometheus?.['llamacpp:predicted_tokens_seconds']);
  put(live, 'prefill_tok_s_mean', prometheus?.['llamacpp:prompt_tokens_seconds']);
  return live;
}

export interface LlamaMetricsInput {
  model: string;
  /** The configured context window, used only when `/slots` does not answer. */
  contextLimit?: number | null | undefined;
  slots?: SlotStats | undefined;
  prometheus?: Record<string, number> | undefined;
  /** What the engine read failed with, if it failed. */
  engineError?: string | undefined;
  gpu?: GpuProbeResult | undefined;
  cpu?: CpuStats | undefined;
  cpuPercent?: number | null | undefined;
  ups?: UpsStats | null | undefined;
  forge?: ControlStats | Record<string, unknown> | undefined;
  history?: MetricsHistory | undefined;
  requests?: RequestRing | undefined;
}

/**
 * Build the whole `/metrics` document for a llama.cpp engine. Keys with no source are
 * absent, so the page hides that card or panel instead of showing a number it was not
 * given — and `conversation_cache`, speculation and routed experts have no source at all
 * in llama.cpp, so they are never invented.
 */
export function buildLlamaMetrics(input: LlamaMetricsInput): MetricsDocument {
  const gpus = input.gpu?.gpus ?? [];
  const live = llamaLive(input.slots, input.prometheus);
  // Nothing to show, and a reason for it: the page says so in the state row.
  if (input.engineError && !live && gpus.length === 0) return { error: input.engineError };

  const metrics: MetricsDocument = {};

  const engine: Record<string, unknown> = { model: input.model };
  const context = maxOf((input.slots?.slots ?? []).map((slot) => slot.size)) ?? undefined;
  put(engine, 'max_context', context ?? input.contextLimit);
  metrics.engine = engine;

  if (live) metrics.live = live;

  const hardware: Record<string, unknown> = {};
  if (gpus.length) {
    hardware.gpus = gpus.map(gpuRow);
    // The aggregate over the cards: mean utilisation, summed memory and power, the
    // hottest temperature. The page draws each card's own line beside these.
    put(hardware, 'gpu_util', meanOf(gpus.map((gpu) => gpu.utilizationPercent)));
    put(hardware, 'gpu_mem_used', sumOf(gpus.map((gpu) => mebibytesToBytes(gpu.memoryUsedMb))));
    put(hardware, 'gpu_mem_total', sumOf(gpus.map((gpu) => mebibytesToBytes(gpu.memoryTotalMb))));
    put(hardware, 'gpu_temp', maxOf(gpus.map((gpu) => gpu.temperatureC)));
    put(hardware, 'gpu_power', sumOf(gpus.map((gpu) => gpu.powerDrawW)));
    put(hardware, 'gpu_power_limit', sumOf(gpus.map((gpu) => gpu.powerLimitW)));
    put(hardware, 'all_gpu_power', sumOf(gpus.map((gpu) => gpu.powerDrawW)));
    put(hardware, 'gpu_pcie_gen', firstOf(gpus.map((gpu) => gpu.pcieGenCurrent)));
    put(hardware, 'gpu_pcie_gen_max', firstOf(gpus.map((gpu) => gpu.pcieGenMax)));
    put(hardware, 'gpu_pcie_width', firstOf(gpus.map((gpu) => gpu.pcieWidthCurrent)));
  }
  put(hardware, 'cpu', input.cpuPercent);
  const ramTotal = os.totalmem();
  hardware.ram_total = ramTotal;
  hardware.ram_used = ramTotal - os.freemem();
  put(hardware, 'cpu_temp', input.cpu?.tempC);
  put(hardware, 'cpu_power', input.cpu?.powerW);
  put(hardware, 'tok_s', input.prometheus?.['llamacpp:predicted_tokens_seconds']);
  put(hardware, 'prefill_tok_s_mean', input.prometheus?.['llamacpp:prompt_tokens_seconds']);
  // `disk_read_mb`, `disk_write_mb` and `measured_power` have no source here, so the disk
  // card stays hidden rather than claiming the machine reads nothing.
  metrics.hardware = hardware;

  const statics: Record<string, unknown> = {
    os: process.platform === 'win32' ? 'windows' : process.platform,
  };
  if (gpus.length) {
    statics.gpu_name = gpus.map((gpu) => gpu.name).join(' + ');
    statics.gpu_count = gpus.length;
    put(statics, 'gpu_vram_total_mib', sumOf(gpus.map((gpu) => gpu.memoryTotalMb)));
  }
  const cores = os.cpus();
  if (cores.length) {
    statics.threads = cores.length;
    const model = cores[0]?.model;
    put(statics, 'cpu_name', model ? model.trim() : undefined);
  }
  // `psutil` stays absent: the disk card reads it to decide whether "needs psutil" is the
  // honest sub-line, and here it is.
  metrics.hardware_static = statics;

  if (input.ups && Object.keys(input.ups.values).length > 0) metrics.ups = input.ups.values;
  if (input.forge) metrics.forge = input.forge as Record<string, unknown>;

  if (input.history) {
    const snapshot = input.history.snapshot();
    if (Object.keys(snapshot).length > 0) metrics.history = snapshot;
  }

  if (input.requests) {
    metrics.requests = input.requests.rows();
    metrics.requests_kept = input.requests.kept();
    metrics.totals = input.requests.totals();
    metrics.monitor_totals_reset = input.requests.wasReset();
  }

  return metrics;
}
