import { spawn, type SpawnOptions } from 'child_process';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import { getLogger } from '../util/logger';
import { deferredStopInvocation, STOP_GRACE_MS } from './deferredStop';
import {
  isConnectionRefused,
  probeExternalModelResidency,
  probeExternalResidencyEndpoints,
  type ExternalResidencyCandidate,
} from './ExternalModelResidencyProbe';
import { probeHttp } from './HealthCheck';

const log = getLogger();

/** How long an unload POST may take; Strata answers once the GPU is free. */
const UNLOAD_TIMEOUT_MS = 60_000;
/** An explicit stop waits for the server to leave its port before reporting success. */
const STOP_TIMEOUT_MS = 90_000;
/** How long to wait for a started server to accept connections before giving up. */
export const START_TIMEOUT_MS = 180_000;
/** How often to probe while waiting for a started server. */
export const START_POLL_MS = 2_000;

type Residency = 'unknown' | 'loaded' | 'unloaded';

export type SecretLookup = (key: string) => Promise<string | undefined>;

export interface StopChild {
  unref(): void;
  kill?(): boolean;
  once?(event: 'error', listener: (error: Error) => void): unknown;
}

export type StopSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => StopChild;

export interface StopOnExitOptions {
  lastWindow: boolean;
  isBusy: (modelName: string) => boolean;
  /** Lifecycle lease directory the deferred watcher re-checks before stopping. */
  leaseDir: string;
}

export class ExternalServerBusyError extends Error {}

/**
 * Managed local servers Forge may unload (`openai-compatible` with
 * `unload_path`). Normal releases keep the server up; explicit unload commands
 * may also run `stop_command`. POSTing the path frees GPU/RAM; requests reload it.
 */
/** A managed external server: openai-compatible with an `unload_path` (Strata). */
export function isManagedExternalModel(
  model: Pick<ModelConfig, 'provider' | 'unload_path'>,
): boolean {
  return model.provider === 'openai-compatible' && !!model.unload_path;
}

export class ExternalModelServers {
  private readonly residency = new Map<string, Residency>();
  /** Incremented before each request so a late unload completion cannot erase it. */
  private readonly activityGeneration = new Map<string, number>();
  /**
   * One in-flight start per model. Without it, two concurrent requests to a
   * down managed server both probe "not reachable" and both spawn
   * `start_command` — two Strata processes racing one port and loading the
   * model into VRAM twice, with the loser then polling the full
   * `START_TIMEOUT_MS` before reporting failure (audit F2, 2026-10-03).
   */
  private readonly starting = new Map<string, Promise<void>>();
  /** A selector refresh probes once per managed model, even across callers. */
  private residencyRefresh: Promise<void> | undefined;

  constructor(
    private readonly getConfig: () => ForgeConfig,
    private readonly secret: SecretLookup,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly spawnImpl: StopSpawner = (command, args, options) =>
      spawn(command, [...args], options),
  ) {}

  /** The resolved model when `name` (a pool key) is a managed server. */
  private managed(name: string): ModelConfig | undefined {
    const config = this.getConfig();
    const raw = config.models.find((m) => m.name === name);
    if (!raw) return undefined;
    const model = mergeGroupsIntoModel(config, raw);
    return isManagedExternalModel(model) ? model : undefined;
  }

  isManaged(name: string): boolean {
    return this.managed(name) !== undefined;
  }

  /**
   * GPUs the group-resolved model's engine uses. No declared cards means it
   * overlaps all; `BackendPoolExternal` uses this to choose which servers to free.
   */
  gpusOf(name: string): readonly number[] | undefined {
    return this.managed(name)?.gpus;
  }

  managedNames(): string[] {
    return this.getConfig()
      .models.map((model) => model.name)
      .filter((name) => this.isManaged(name));
  }

  /** Unknown counts as loaded: a server started by hand may hold VRAM. */
  isLoaded(name: string): boolean {
    return this.isManaged(name) && this.residency.get(name) !== 'unloaded';
  }

  /** A selector dot is confirmed only after a request or matching server probe. */
  isConfirmedLoaded(name: string): boolean {
    return this.isManaged(name) && this.residency.get(name) === 'loaded';
  }

  loadedNames(): string[] {
    return this.getConfig()
      .models.map((m) => m.name)
      .filter((name) => this.isLoaded(name));
  }

  /** A request is about to go to `name`; the server will load its model. */
  markInUse(name: string): void {
    if (!this.isManaged(name)) return;
    this.activityGeneration.set(name, (this.activityGeneration.get(name) ?? 0) + 1);
    this.residency.set(name, 'loaded');
  }

  /** Reconcile confirmed residency with the managed server without loading it. */
  refreshResidency(): Promise<void> {
    if (this.residencyRefresh) return this.residencyRefresh;
    const refresh = this.refreshLoadedResidency()
      .catch((error: unknown) => {
        log.error('[ExternalModelServers] could not refresh residency', error);
      })
      .finally(() => {
        if (this.residencyRefresh === refresh) this.residencyRefresh = undefined;
      });
    this.residencyRefresh = refresh;
    return refresh;
  }

  private async refreshLoadedResidency(): Promise<void> {
    const probes: Array<{ name: string; model: ModelConfig }> = [];
    for (const entry of this.getConfig().models) {
      const model = this.managed(entry.name);
      if (model?.endpoint && !this.starting.has(entry.name)) {
        probes.push({ name: entry.name, model });
      }
    }

    const results = await Promise.allSettled(
      probes.map(({ name, model }) => this.refreshModelResidency(name, model)),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;
  }

  private async refreshModelResidency(name: string, model: ModelConfig): Promise<void> {
    if (this.starting.has(name) || !model.endpoint) {
      return;
    }
    const generation = this.activityGeneration.get(name) ?? 0;
    const token = model.api_key_secret ? await this.secret(model.api_key_secret) : undefined;
    if (this.starting.has(name)) return;
    const result = await probeExternalModelResidency(
      model.endpoint,
      model.model,
      token,
      this.fetchImpl,
    );
    if (this.starting.has(name)) return;
    if (result.state === 'connection-refused') {
      this.markUnloadedUnlessReused(name, generation, 'residency refresh');
      log.info(`[ExternalModelServers] "${name}" stopped outside this window`);
    } else if (
      result.state === 'unloaded' ||
      result.state === 'stale-claim' ||
      (result.state === 'loaded' && !result.matchesModel)
    ) {
      this.markUnloadedUnlessReused(name, generation, 'residency refresh');
    } else if (
      result.state === 'loaded' &&
      (this.activityGeneration.get(name) ?? 0) === generation
    ) {
      this.residency.set(name, 'loaded');
    }
  }

  /** Re-read endpoints whose remembered state could otherwise omit a resident server. */
  async reconcileForFree(names: readonly string[]): Promise<void> {
    const generations = new Map<string, number>();
    const candidates: ExternalResidencyCandidate[] = [];
    for (const name of names) {
      const model = this.managed(name);
      if (!model?.endpoint || this.residency.get(name) === 'loaded' || this.starting.has(name)) {
        continue;
      }
      generations.set(name, this.activityGeneration.get(name) ?? 0);
      candidates.push({ name, endpoint: model.endpoint, apiKeySecret: model.api_key_secret });
    }
    const results = await probeExternalResidencyEndpoints(candidates, this.secret, this.fetchImpl);
    for (const { names: endpointNames, result } of results) {
      const residency: Residency =
        result.state === 'connection-refused' || result.state === 'unloaded'
          ? 'unloaded'
          : 'unknown';
      for (const name of endpointNames) {
        if (
          !this.starting.has(name) &&
          (this.activityGeneration.get(name) ?? 0) === generations.get(name)
        ) {
          this.residency.set(name, residency);
        }
      }
    }
  }

  async unload(name: string): Promise<void> {
    const model = this.managed(name);
    if (!model?.endpoint || !model.unload_path) return;
    const generation = this.activityGeneration.get(name) ?? 0;
    const url = new URL(model.unload_path, model.endpoint).toString();
    const token = model.api_key_secret ? await this.secret(model.api_key_secret) : undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        // Strata's /unload (and /load, /settings) reject a non-JSON POST with 415
        // "send application/json" — a CSRF/rebinding guard (server.py _own_page).
        // A fire-and-forget control POST still has to declare itself as JSON.
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(UNLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      // No listening server holds no VRAM — the one error that means "unloaded".
      if (isConnectionRefused(err)) {
        this.markUnloadedUnlessReused(name, generation);
        log.info(`[ExternalModelServers] "${name}" is not running — nothing to unload`);
        return;
      }
      throw new Error(`Could not unload "${name}" (${url}): ${describe(err)}`);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 300);
      const busy = response.status === 409 ? ' — a request is still running on it' : '';
      const message = `Could not unload "${name}": HTTP ${response.status}${busy} ${body}`.trim();
      if (response.status === 409) throw new ExternalServerBusyError(message);
      throw new Error(message);
    }
    this.markUnloadedUnlessReused(name, generation);
    log.info(`[ExternalModelServers] unloaded "${name}"`);
  }

  /** Explicit /unload: free the model, then stop its configured server process. */
  async unloadAndStop(name: string): Promise<void> {
    await this.unload(name); // A busy server (409) must never be stopped.
    await this.stopAfterUnload(name);
  }

  /** Explicit /unloadall also stops configured servers that were already unloaded. */
  async unloadAllAndStop(): Promise<void> {
    await this.unloadAll();
    for (const model of this.getConfig().models) {
      if (this.isManaged(model.name)) await this.stopAfterUnload(model.name);
    }
  }

  private async stopAfterUnload(name: string): Promise<void> {
    const model = this.managed(name);
    if (!model?.stop_command || !model.endpoint) return;
    if (!(await probeHttp(model.endpoint)).reachable) return;
    const [command, ...args] = model.stop_command;
    let launchError: Error | undefined;
    try {
      const child = this.spawnImpl(command, args, {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.once?.('error', (error) => {
        launchError = error;
      });
      child.unref();
    } catch (error) {
      throw new Error(`Could not stop "${name}": ${describe(error)}`);
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    for (;;) {
      if (launchError) throw new Error(`Could not stop "${name}": ${launchError.message}`);
      if (!(await probeHttp(model.endpoint)).reachable) {
        log.info(`[ExternalModelServers] stopped "${name}" after explicit unload`);
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `"${name}" was unloaded but its server did not stop within ${STOP_TIMEOUT_MS / 1000}s`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    }
  }

  /** Ensure the endpoint is reachable, starting it when `start_command` is configured. */
  async ensureStarted(name: string): Promise<void> {
    const pending = this.starting.get(name);
    if (pending) return pending;
    const start = this.startOnce(name).finally(() => {
      // Only drop OUR entry: a retry that began while this one unwound owns
      // the map by then, and deleting it would let a third caller double-start.
      if (this.starting.get(name) === start) this.starting.delete(name);
    });
    this.starting.set(name, start);
    return start;
  }

  private async startOnce(name: string): Promise<void> {
    const model = this.managed(name);
    if (!model?.endpoint) return;
    if ((await probeHttp(model.endpoint)).reachable) return; // already up
    if (!model.start_command?.length) {
      throw new Error(
        `"${name}" is not running (nothing is listening at ${model.endpoint}). ` +
          'Start it manually, or set start_command so Forge can start it.',
      );
    }
    // A command that cannot run (ENOENT, EACCES) fails asynchronously; stop
    // polling on it rather than wait out START_TIMEOUT_MS.
    let launchError: Error | undefined;
    this.launchStart(model, (error) => (launchError = error));
    const ready = await this.waitReachable(model.endpoint, () => launchError !== undefined);
    if (launchError) {
      throw new Error(`Start command for "${name}" failed: ${describe(launchError)}`);
    }
    if (!ready) {
      throw new Error(
        `"${name}" was started but did not become reachable at ${model.endpoint} ` +
          `within ${START_TIMEOUT_MS / 1000}s. It may still be starting — retry.`,
      );
    }
    log.info(`[ExternalModelServers] started "${name}"`);
  }

  /** Launch `start_command` detached so it survives the extension host. */
  private launchStart(model: ModelConfig, onError: (error: Error) => void): void {
    const [command, ...args] = model.start_command!;
    try {
      const resolvedArgs = args.map((arg) => {
        if (arg !== '{num_ctx}') return arg;
        const numCtx = model.num_ctx;
        if (numCtx === undefined || !Number.isInteger(numCtx) || numCtx <= 0) {
          throw new Error(
            `start_command uses "{num_ctx}", but "${model.name}" has no valid num_ctx`,
          );
        }
        return String(numCtx);
      });
      const child = this.spawnImpl(command, resolvedArgs, {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.once?.('error', (error) => {
        log.error(`[ExternalModelServers] start command failed for "${model.name}"`, error);
        onError(error);
      });
      child.unref();
      log.info(`[ExternalModelServers] launched start command for "${model.name}"`);
    } catch (error) {
      throw new Error(`Could not launch start command for "${model.name}": ${describe(error)}`);
    }
  }

  /** Poll the endpoint until it accepts connections or the timeout is reached. */
  private async waitReachable(endpoint: string, failed: () => boolean): Promise<boolean> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      if ((await probeHttp(endpoint)).reachable) return true;
      if (failed() || Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    }
  }

  /** Unload every managed server that may hold memory; reports every failure. */
  async unloadAll(alreadyReconciled = false): Promise<void> {
    if (!alreadyReconciled) await this.reconcileForFree(this.managedNames());
    const results = await Promise.allSettled(this.loadedNames().map((n) => this.unload(n)));
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    if (failures.length) throw new Error(failures.join('\n'));
  }

  /**
   * For each opted-in server: start the deferred stop watcher, then unload.
   * The watcher starts first because the host may die before the unload
   * returns; a server-reported busy (409) cancels it while the host lives.
   */
  async stopOnExit(options: StopOnExitOptions): Promise<void> {
    const models = this.getConfig().models.filter((model) => model.stop_on_exit === true);
    for (const model of models) {
      if (!options.lastWindow) {
        log.info(`[ExternalModelServers] skipped stop "${model.name}": other Forge windows`);
        continue;
      }
      if (options.isBusy(model.name)) {
        log.info(`[ExternalModelServers] skipped stop "${model.name}": busy in this window`);
        continue;
      }
      const watcher = this.launchStop(model, options.leaseDir);
      try {
        await this.unload(model.name);
      } catch (error) {
        if (error instanceof ExternalServerBusyError) {
          watcher?.kill?.();
          log.info(`[ExternalModelServers] skipped stop "${model.name}": server reported busy`);
        } else {
          log.error(`[ExternalModelServers] could not unload "${model.name}" before stop`, error);
        }
      }
    }
  }

  private markUnloadedUnlessReused(name: string, generation: number, operation = 'unload'): void {
    if ((this.activityGeneration.get(name) ?? 0) === generation) {
      this.residency.set(name, 'unloaded');
    } else {
      log.info(
        `[ExternalModelServers] "${name}" was requested during ${operation}; residency stays loaded`,
      );
    }
  }

  private launchStop(model: ModelConfig, leaseDir: string): StopChild | undefined {
    const stopCommand = model.stop_command ?? [];
    if (!stopCommand[0]) return undefined; // Config validation makes this unreachable in production.
    const { command, args, env } = deferredStopInvocation(leaseDir, STOP_GRACE_MS, stopCommand);
    try {
      const child = this.spawnImpl(command, args, {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env,
      });
      child.once?.('error', (error) =>
        log.error(`[ExternalModelServers] stop watcher failed for "${model.name}"`, error),
      );
      child.unref();
      log.info(
        `[ExternalModelServers] stop scheduled for "${model.name}" in ${STOP_GRACE_MS / 1000} s unless a Forge window reopens`,
      );
      return child;
    } catch (error) {
      log.error(`[ExternalModelServers] could not launch stop for "${model.name}"`, error);
      return undefined;
    }
  }
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
}

/**
 * Runs before every openai-compatible request (`resolveCloudRequestTarget`).
 * The pool registers it at activation: a request to a managed server first
 * frees any local llama.cpp/Ollama model. Unset in tests and for configs
 * without managed servers.
 */
let requestHook: ((model: ModelConfig) => Promise<void>) | undefined;

export function setExternalRequestHook(
  hook: ((model: ModelConfig) => Promise<void>) | undefined,
): void {
  requestHook = hook;
}

export async function beforeExternalRequest(model: ModelConfig): Promise<void> {
  if (model.unload_path) await requestHook?.(model);
}
