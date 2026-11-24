import type { ForgeConfig, ModelConfig } from '../config/types';
import type { IBackendPool } from '../backend/BackendPool';
import type { ControlStats } from '../backend/controlStats';
import { isManagedExternalModel } from '../backend/ExternalModelServers';
import { readStrataMetrics } from './strataStats';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import type { MetricsDocument } from './monitorTypes';
import { noStatsReaderMessage } from './monitorTypes';

/** How often the panel's reading is refreshed, as in Strata's own poll loop. */
const ENGINE_POLL_MS = 2000;

export interface MonitorPollerOptions {
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  getStats: () => ControlStats;
  getSecret: (name: string) => Promise<string | undefined>;
  post: (metrics: MetricsDocument) => void;
}

export interface MonitorPollers {
  start(): void;
  stop(): void;
  dispose(): void;
  diagnostics(): { timers: number; controllers: AbortController[] };
}

/**
 * One reading for the Monitor panel, refreshed while it is visible and cancelled the
 * moment it is hidden or disposed: the panel shows Strata's page, so the reading is
 * Strata's `/metrics` document for the model being shown.
 */
export function createMonitorPollers(options: MonitorPollerOptions): MonitorPollers {
  const timers = new Set<ReturnType<typeof setInterval>>();
  const controllers = new Set<AbortController>();
  const busy = new Set<string>();
  let active = false;
  let disposed = false;

  const poll = (
    key: string,
    intervalMs: number,
    run: (signal: AbortSignal) => Promise<MetricsDocument | undefined>,
  ): void => {
    const tick = (): void => {
      if (!active || disposed || busy.has(key)) return;
      busy.add(key);
      const controller = new AbortController();
      controllers.add(controller);
      void run(controller.signal)
        .then((metrics) => {
          if (metrics && active && !disposed) options.post(metrics);
        })
        .catch((error: unknown) => {
          // Hiding the panel cancels the read in flight. That is not a failed
          // engine, so it stays silent rather than putting the page in an error state.
          if (controller.signal.aborted || !active || disposed) return;
          options.post({ error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          controllers.delete(controller);
          busy.delete(key);
        });
    };
    tick();
    timers.add(setInterval(tick, intervalMs));
  };

  return {
    start(): void {
      if (active || disposed) return;
      active = true;
      poll('engine', ENGINE_POLL_MS, async (signal) => readShownMetrics(options, signal));
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

/** The model the panel shows: the active one when it is loaded, else the only loaded one. */
export function shownModel(
  options: MonitorPollerOptions,
  config: ForgeConfig,
): ModelConfig | undefined {
  const loaded = config.models
    .map((model) => mergeGroupsIntoModel(config, model))
    .filter((model) => options.pool.isLoaded(model.name));
  if (!loaded.length) return undefined;
  return loaded.find((model) => model.name === config.active_model) ?? loaded[0];
}

async function readShownMetrics(
  options: MonitorPollerOptions,
  signal: AbortSignal,
): Promise<MetricsDocument | undefined> {
  const config = options.getConfig();
  const model = shownModel(options, config);
  if (!model) return undefined;
  if (model.stats === 'strata' && model.endpoint) {
    const secret = model.api_key_secret ? await options.getSecret(model.api_key_secret) : undefined;
    const metrics = await readStrataMetrics(model.endpoint, secret, signal, fetch);
    // The Forge card reads the `forge` block. A Strata server builds it from Forge's own
    // session logs; one that does not answer with it gets Forge's live numbers instead.
    if (!metrics.error && metrics.forge === undefined) metrics.forge = options.getStats();
    return metrics;
  }
  // A llama.cpp engine (Forge-spawned or `stats: llama`) gets its reading from
  // `llamaMetricsShape.ts`; until it answers, this model simply has no reading yet.
  if (model.provider === 'llama.cpp' || model.stats === 'llama') return undefined;
  if (isManagedExternalModel(model)) return { error: noStatsReaderMessage(model.name) };
  return undefined;
}
