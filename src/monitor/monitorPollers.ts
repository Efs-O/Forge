import * as os from 'os';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { IBackendPool } from '../backend/BackendPool';
import type { ControlStats } from '../backend/controlStats';
import { isManagedExternalModel } from '../backend/ExternalModelServers';
import { readStrataMetrics, resetStrataMetrics } from './strataStats';
import { readLlamaStats } from './llamaServerStats';
import { readLhmCpuStats } from './lhmCpuStats';
import { readNutStats } from './nutClient';
import { createCpuLoadSampler, describeProbeFailure, probeGpus } from '../system/systemProbes';
import type { CpuLoadSampler, GpuInfo } from '../system/systemProbes';
import {
  buildLlamaMetrics,
  createMetricsHistory,
  createRequestRing,
  type MetricsHistory,
  type RequestRing,
} from './llamaMetricsShape';
import { subscribeRequestCaptures } from '../sessions/requestStats';
import type { RequestCapture } from '../sessions/requestStats';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import type {
  CpuStats,
  GpuProbeResult,
  MetricsDocument,
  SlotStats,
  UpsStats,
} from './monitorTypes';
import { noStatsReaderMessage } from './monitorTypes';

/** How often the panel's reading is refreshed, as in Strata's own poll loop. */
const ENGINE_POLL_MS = 2000;
/** The readings that are not needed at the speed of the numbers beside them. */
const SLOW_POLL_MS = 5000;
/** A dead LibreHardwareMonitor must not cost a connection attempt every tick. */
const CPU_RETRY_MS = 30_000;

export interface MonitorPollerOptions {
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  getStats: () => ControlStats;
  getSecret: (name: string) => Promise<string | undefined>;
  post: (metrics: MetricsDocument) => void;
  /** Overridable so a test never spawns `nvidia-smi` or opens a socket. */
  probeGpus?: (signal: AbortSignal) => Promise<GpuInfo[]>;
  fetchImpl?: typeof fetch;
}

export interface MonitorPollers {
  start(): void;
  stop(): void;
  dispose(): void;
  /** The panel's Clear button: the totals start again, then the page repaints. */
  clear(): void;
  diagnostics(): { timers: number; controllers: AbortController[]; capturing: boolean };
}

/** What the last reading of each source gave, kept between polls so one document can be
 *  assembled whenever any one of them changes. */
interface ReadingParts {
  gpu?: GpuProbeResult | undefined;
  cpu?: CpuStats | undefined;
  ups?: UpsStats | undefined;
  slots?: SlotStats | undefined;
  prometheus?: Record<string, number> | undefined;
  engineError?: string | undefined;
}

/**
 * One reading for the Monitor panel, refreshed while it is visible and cancelled the
 * moment it is hidden or disposed: the panel shows Strata's page, so every reading is a
 * Strata `/metrics` document for the model being shown — passed through from a Strata
 * engine, shaped by `llamaMetricsShape.ts` for a llama.cpp one.
 */
export function createMonitorPollers(options: MonitorPollerOptions): MonitorPollers {
  const timers = new Set<ReturnType<typeof setInterval>>();
  const controllers = new Set<AbortController>();
  const busy = new Set<string>();
  const parts: ReadingParts = {};
  const fetchImpl = options.fetchImpl ?? fetch;
  const history: MetricsHistory = createMetricsHistory();
  const requests: RequestRing = createRequestRing();
  const cpuSampler: CpuLoadSampler = createCpuLoadSampler();
  let active = false;
  let disposed = false;
  let cpuRetryAt = 0;
  let clearError: string | undefined;
  let unsubscribeCaptures: (() => void) | undefined;
  /** True while the panel is collecting Forge's finished requests for the table. */
  let capturing = false;

  const run = async (
    key: string,
    read: (signal: AbortSignal) => Promise<MetricsDocument | undefined>,
  ): Promise<void> => {
    if (!active || disposed || busy.has(key)) return;
    busy.add(key);
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const metrics = await read(controller.signal);
      if (metrics && active && !disposed) options.post(metrics);
    } catch (error: unknown) {
      // Hiding the panel cancels the read in flight. That is not a failed engine, so it
      // stays silent rather than putting the page in an error state.
      if (controller.signal.aborted || !active || disposed) return;
      options.post({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      controllers.delete(controller);
      busy.delete(key);
    }
  };

  const poll = (
    key: string,
    intervalMs: number,
    read: (signal: AbortSignal) => Promise<MetricsDocument | undefined>,
  ): void => {
    void run(key, read);
    timers.add(setInterval(() => void run(key, read), intervalMs));
  };

  /** The model the panel shows, or undefined when nothing loaded can be read. */
  const shown = (): ModelConfig | undefined => shownModel(options, options.getConfig());

  const assembleLlama = (model: ModelConfig): MetricsDocument =>
    buildLlamaMetrics({
      model: model.name,
      contextLimit: model.num_ctx,
      slots: parts.slots,
      prometheus: parts.prometheus,
      engineError: parts.engineError,
      gpu: parts.gpu,
      cpu: parts.cpu,
      cpuPercent: cpuSampler.sample(),
      ups: parts.ups,
      forge: options.getStats(),
      history,
      requests,
    });

  /** One history sample per engine tick, whatever each source managed to answer. */
  const sampleHistory = (): void => {
    const gpus = parts.gpu?.gpus ?? [];
    history.push({
      gpu_util: gpus.length ? mean(gpus.map((gpu) => gpu.utilizationPercent)) : null,
      gpu_mem_used: gpus.length ? sum(gpus.map((gpu) => gibibytes(gpu.memoryUsedMb))) : null,
      gpu_temp: gpus.length ? hottest(gpus.map((gpu) => gpu.temperatureC)) : null,
      gpu_power: gpus.length ? sum(gpus.map((gpu) => gpu.powerDrawW)) : null,
      cpu: cpuSampler.sample(),
      ram_used: usedMemoryBytes(),
      tok_s: parts.prometheus?.['llamacpp:predicted_tokens_seconds'] ?? null,
      prefill_tok_s_mean: parts.prometheus?.['llamacpp:prompt_tokens_seconds'] ?? null,
      all_gpu_power: gpus.length ? sum(gpus.map((gpu) => gpu.powerDrawW)) : null,
      cpu_temp: parts.cpu?.tempC ?? null,
      cpu_power: parts.cpu?.powerW ?? null,
      gpus: gpus.map((gpu) => ({
        index: gpu.index,
        util: gpu.utilizationPercent,
        mem_used: gibibytes(gpu.memoryUsedMb),
        temp: gpu.temperatureC,
        power: gpu.powerDrawW,
      })),
    });
  };

  const engineReading = async (signal: AbortSignal): Promise<MetricsDocument | undefined> => {
    const model = shown();
    if (!model) return undefined;
    if (isStrataModel(model) && model.endpoint) {
      const secret = model.api_key_secret
        ? await options.getSecret(model.api_key_secret)
        : undefined;
      const metrics = await readStrataMetrics(model.endpoint, secret, signal, fetchImpl);
      // The Forge card reads the `forge` block. A Strata server builds it from Forge's own
      // session logs; one that does not answer with it gets Forge's live numbers instead.
      if (!metrics.error && metrics.forge === undefined) metrics.forge = options.getStats();
      if (clearError !== undefined) {
        metrics.clear_error = clearError;
        clearError = undefined;
      }
      return metrics;
    }
    if (!isLlamaModel(model)) {
      return isManagedExternalModel(model)
        ? { error: noStatsReaderMessage(model.name) }
        : undefined;
    }
    const base = llamaBaseUrl(options, model);
    if (!base) return undefined;
    const read = await readLlamaStats(base, signal);
    parts.slots = read.slots;
    parts.prometheus = read.metrics;
    parts.engineError = read.error;
    sampleHistory();
    return assembleLlama(model);
  };

  const hardwareReading = async (signal: AbortSignal): Promise<MetricsDocument | undefined> => {
    const model = shown();
    if (!model || !isLlamaModel(model)) return undefined;
    try {
      parts.gpu = { gpus: await (options.probeGpus ?? probeGpus)(signal) };
    } catch (error: unknown) {
      // A machine without nvidia-smi, or with a driver that will not answer, says so once:
      // the cards stay hidden, and the reason is in the log rather than on the page.
      parts.gpu = { gpus: [], error: describeProbeFailure(error) };
    }
    return assembleLlama(model);
  };

  const cpuReading = async (signal: AbortSignal): Promise<MetricsDocument | undefined> => {
    const model = shown();
    const url = options.getConfig().monitor?.cpu;
    if (!model || !isLlamaModel(model) || !url) return undefined;
    if (Date.now() < cpuRetryAt) return undefined;
    try {
      parts.cpu = await readLhmCpuStats(url, signal);
    } catch (error: unknown) {
      // Hiding the panel aborts the read in flight. That is not a broken sensor: keep the
      // last reading and do not park the reader, or the panel comes back to
      // "This operation was aborted" for 30 s. A real failure still counts here.
      if (signal.aborted) return undefined;
      parts.cpu = {
        tempC: null,
        powerW: null,
        error: error instanceof Error ? error.message : String(error),
      };
      cpuRetryAt = Date.now() + CPU_RETRY_MS;
    }
    return assembleLlama(model);
  };

  const upsReading = async (signal: AbortSignal): Promise<MetricsDocument | undefined> => {
    const model = shown();
    const spec = options.getConfig().monitor?.ups;
    if (!model || !isLlamaModel(model) || !spec) return undefined;
    try {
      parts.ups = await readNutStats(spec, signal);
    } catch (error: unknown) {
      parts.ups = { values: {}, error: error instanceof Error ? error.message : String(error) };
    }
    return assembleLlama(model);
  };

  return {
    start(): void {
      if (active || disposed) return;
      active = true;
      // Forge's own finished requests feed the table and the totals. The subscription
      // outlives a hidden panel: the rows made while it was hidden are still there when
      // it comes back, and the ring's cap is what bounds it.
      unsubscribeCaptures ??= subscribeRequestCaptures((capture: RequestCapture) => {
        requests.record(capture);
      });
      capturing = true;
      poll('engine', ENGINE_POLL_MS, engineReading);
      poll('hardware', ENGINE_POLL_MS, hardwareReading);
      poll('cpu', ENGINE_POLL_MS, cpuReading);
      poll('ups', SLOW_POLL_MS, upsReading);
    },
    stop(): void {
      active = false;
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeCaptures?.();
      unsubscribeCaptures = undefined;
      capturing = false;
      this.stop();
    },
    clear(): void {
      const model = shown();
      if (!model) return;
      const endpoint = isStrataModel(model) ? model.endpoint : undefined;
      if (endpoint) {
        // The totals the page shows are the server's, so the server has to start them
        // again; then one poll at once, so the page repaints with the reset numbers.
        const secretName = model.api_key_secret;
        void (async (): Promise<void> => {
          try {
            const secret = secretName ? await options.getSecret(secretName) : undefined;
            const result = await resetStrataMetrics(endpoint, secret, fetchImpl);
            if (!result.ok) clearError = result.message;
          } catch (error: unknown) {
            clearError = error instanceof Error ? error.message : String(error);
          } finally {
            void run('engine', engineReading);
          }
        })();
        return;
      }
      // A llama.cpp engine keeps nothing: the rings here are the totals and the graphs.
      requests.reset();
      history.reset();
      const assembled = assembleLlama(model);
      if (clearError !== undefined) {
        assembled.clear_error = clearError;
        clearError = undefined;
      }
      options.post(assembled);
    },
    diagnostics: () => ({
      timers: timers.size,
      controllers: [...controllers],
      capturing,
    }),
  };
}

/**
 * The model the panel shows: the serving model first, the active one among equals.
 * An external engine stopped outside Forge stays "loaded" as unknown.
 */
export function shownModel(
  options: MonitorPollerOptions,
  config: ForgeConfig,
): ModelConfig | undefined {
  const loaded = config.models
    .map((model) => mergeGroupsIntoModel(config, model))
    .filter((model) => options.pool.isLoaded(model.name));
  if (!loaded.length) return undefined;
  const ready = loaded.filter((model) => options.pool.isModelReady(model.name));
  if (ready.length) {
    return ready.find((model) => model.name === config.active_model) ?? ready[0];
  }
  return loaded.find((model) => model.name === config.active_model) ?? loaded[0];
}

function isStrataModel(model: ModelConfig): boolean {
  return model.stats === 'strata' && !!model.endpoint;
}

/** A Forge-spawned llama-server, or an external engine declared as `stats: llama`.
 *  No `provider` means llama.cpp, as the schema says: most GGUF entries leave it out. */
function isForgeLlama(model: ModelConfig): boolean {
  return (model.provider ?? 'llama.cpp') === 'llama.cpp';
}

function isLlamaModel(model: ModelConfig): boolean {
  return isForgeLlama(model) || model.stats === 'llama';
}

/** Where to ask for slots and Prometheus counters, or undefined when the server has no
 *  address yet (a Forge-spawned one that is still starting). */
function llamaBaseUrl(options: MonitorPollerOptions, model: ModelConfig): string | undefined {
  if (isForgeLlama(model)) return options.pool.modelBaseUrl(model.name) ?? undefined;
  return model.endpoint ? new URL(model.endpoint).origin : undefined;
}

const finite = (values: readonly (number | null | undefined)[]): number[] =>
  values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

const sum = (values: readonly (number | null | undefined)[]): number | null => {
  const kept = finite(values);
  return kept.length ? kept.reduce((total, value) => total + value, 0) : null;
};

const mean = (values: readonly (number | null | undefined)[]): number | null => {
  const total = sum(values);
  return total === null ? null : total / finite(values).length;
};

const hottest = (values: readonly (number | null | undefined)[]): number | null => {
  const kept = finite(values);
  return kept.length ? Math.max(...kept) : null;
};

/** Used RAM, in bytes — the unit Strata's `hardware` and its history series use. */
function usedMemoryBytes(): number {
  return os.totalmem() - os.freemem();
}

/** `nvidia-smi` answers in MiB; the page's memory values are bytes. */
function gibibytes(mib: number | null | undefined): number | null {
  return mib === undefined || mib === null ? null : mib * 1048576;
}
