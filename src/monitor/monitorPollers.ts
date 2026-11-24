import type { ForgeConfig } from '../config/types';
import type { IBackendPool } from '../backend/BackendPool';
import type { ControlStats } from '../backend/controlStats';
import { isManagedExternalModel } from '../backend/ExternalModelServers';
import { describeProbeFailure, probeGpus } from '../system/systemProbes';
import { readLlamaStats } from './llamaServerStats';
import { readLhmCpuStats } from './lhmCpuStats';
import { readNutStats } from './nutClient';
import { readStrataStats } from './strataStats';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import type {
  CpuStats,
  EngineMonitor,
  GpuProbeResult,
  MonitorSnapshot,
  UpsStats,
} from './monitorTypes';
import { noStatsReaderMessage } from './monitorTypes';
import type { GpuInfo } from '../system/systemProbes';

/** How long a failed LibreHardwareMonitor read is left alone, as in Strata's `_LhmCpu`. */
const CPU_RETRY_MS = 30_000;

export interface MonitorPollerOptions {
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  getStats: () => ControlStats;
  getSecret: (name: string) => Promise<string | undefined>;
  probeGpus?: (signal: AbortSignal) => Promise<GpuInfo[]>;
  post: (snapshot: MonitorSnapshot) => void;
}

export interface MonitorPollers {
  start(): void;
  stop(): void;
  dispose(): void;
  diagnostics(): { timers: number; controllers: AbortController[] };
}

export function createMonitorPollers(options: MonitorPollerOptions): MonitorPollers {
  const timers = new Set<ReturnType<typeof setInterval>>();
  const controllers = new Set<AbortController>();
  const busy = new Set<string>();
  let active = false;
  let disposed = false;
  let gpus: GpuProbeResult = { gpus: [] };
  let engines: EngineMonitor[] = [];
  let forge = options.getStats();
  let ups: UpsStats | undefined;
  let cpu: CpuStats | undefined;
  let cpuRetryAt = 0;

  const post = (): void => {
    if (active && !disposed)
      options.post({ gpus, engines, forge, ...(ups ? { ups } : {}), ...(cpu ? { cpu } : {}) });
  };
  const poll = (
    key: string,
    intervalMs: number,
    run: (signal: AbortSignal) => Promise<void>,
  ): void => {
    const tick = (): void => {
      if (!active || disposed || busy.has(key)) return;
      busy.add(key);
      const controller = new AbortController();
      controllers.add(controller);
      const deadline = key === 'gpus' ? setTimeout(() => controller.abort(), 6500) : undefined;
      void run(controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            if (key === 'gpus') gpus = { gpus: [], error: describeProbeFailure(error) };
            else if (key === 'engine')
              engines = [
                {
                  name: 'Engine',
                  provider: 'unknown',
                  engine: { error: error instanceof Error ? error.message : String(error) },
                },
              ];
            else if (key === 'ups')
              ups = { values: {}, error: error instanceof Error ? error.message : String(error) };
          }
        })
        .finally(() => {
          if (deadline) clearTimeout(deadline);
          controllers.delete(controller);
          busy.delete(key);
          post();
        });
    };
    tick();
    timers.add(setInterval(tick, intervalMs));
  };

  return {
    start(): void {
      if (active || disposed) return;
      active = true;
      poll('gpus', 2000, async (signal) => {
        gpus = { gpus: await (options.probeGpus ?? probeGpus)(signal) };
      });
      poll('engine', 2000, async (signal) => {
        engines = await pollEngines(options, signal);
      });
      poll('forge', 5000, async () => {
        forge = options.getStats();
      });
      if (options.getConfig().monitor?.ups) {
        poll('ups', 5000, async (signal) => {
          try {
            ups = await readNutStats(options.getConfig().monitor!.ups!, signal);
          } catch (error) {
            ups = { values: {}, error: error instanceof Error ? error.message : String(error) };
          }
        });
      }
      if (options.getConfig().monitor?.cpu) {
        poll('cpu', 2000, async (signal) => {
          // A dead LibreHardwareMonitor must not cost a connection attempt every
          // tick: the failure parks the reader for CPU_RETRY_MS instead.
          if (Date.now() < cpuRetryAt) return;
          try {
            cpu = await readLhmCpuStats(options.getConfig().monitor!.cpu!, signal);
          } catch (error) {
            // Hiding the panel aborts the read in flight. That is not a broken
            // sensor: keep the last reading and do not park the reader, or the
            // panel comes back to "This operation was aborted" for 30 s. A real
            // failure still counts here, including the 1500 ms timeout, which
            // aborts the combined signal and leaves `signal` alone.
            if (signal.aborted) return;
            cpu = {
              tempC: null,
              powerW: null,
              error: error instanceof Error ? error.message : String(error),
            };
            cpuRetryAt = Date.now() + CPU_RETRY_MS;
          }
        });
      }
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
      this.stop();
    },
    diagnostics: () => ({ timers: timers.size, controllers: [...controllers] }),
  };
}

async function pollEngines(
  options: MonitorPollerOptions,
  signal: AbortSignal,
): Promise<EngineMonitor[]> {
  const config = options.getConfig();
  const models = config.models
    .map((model) => mergeGroupsIntoModel(config, model))
    .filter((model) => options.pool.isLoaded(model.name));
  const result: EngineMonitor[] = [];
  for (const model of models) {
    if (signal.aborted) break;
    try {
      if (model.provider === 'llama.cpp') {
        const baseUrl = options.pool.modelBaseUrl(model.name);
        if (!baseUrl) continue;
        const read = await readLlamaStats(baseUrl, signal);
        result.push({
          name: model.name,
          provider: 'llama.cpp',
          engine: {
            ...statsFields(read.metrics),
            ...(read.error ? { error: read.error } : {}),
            ...(read.slots ? { slots: read.slots } : {}),
          },
        });
      } else if (isManagedExternalModel(model)) {
        if (!model.stats) {
          result.push({
            name: model.name,
            provider: 'openai-compatible',
            engine: { error: noStatsReaderMessage(model.name) },
          });
        } else if (model.stats === 'strata' && model.endpoint) {
          const secret = model.api_key_secret
            ? await options.getSecret(model.api_key_secret)
            : undefined;
          result.push({
            name: model.name,
            provider: 'openai-compatible',
            engine: await readStrataStats(model.endpoint, secret, signal, fetch, model.num_ctx),
          });
        } else if (model.stats === 'llama' && model.endpoint) {
          const read = await readLlamaStats(new URL(model.endpoint).origin, signal);
          result.push({
            name: model.name,
            provider: 'openai-compatible',
            engine: {
              ...statsFields(read.metrics),
              ...(read.error ? { error: read.error } : {}),
              ...(read.slots ? { slots: read.slots } : {}),
            },
          });
        }
      }
    } catch (error) {
      if (signal.aborted) break;
      result.push({
        name: model.name,
        provider: model.provider ?? 'unknown',
        engine: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return result;
}

function statsFields(
  metrics: Record<string, number> | undefined,
): Partial<import('./monitorTypes').LlamaStats> {
  if (!metrics) return {};
  return {
    ...(metrics['llamacpp:prompt_tokens_seconds'] !== undefined
      ? { promptTokensPerSecond: metrics['llamacpp:prompt_tokens_seconds'] }
      : {}),
    ...(metrics['llamacpp:predicted_tokens_seconds'] !== undefined
      ? { predictedTokensPerSecond: metrics['llamacpp:predicted_tokens_seconds'] }
      : {}),
    ...(metrics['llamacpp:requests_processing'] !== undefined
      ? { requestsProcessing: metrics['llamacpp:requests_processing'] }
      : {}),
    ...(metrics['llamacpp:requests_deferred'] !== undefined
      ? { requestsDeferred: metrics['llamacpp:requests_deferred'] }
      : {}),
  };
}
