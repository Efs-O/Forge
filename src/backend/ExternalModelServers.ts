import { spawn, type SpawnOptions } from 'child_process';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import { getLogger } from '../util/logger';
import { deferredStopInvocation, STOP_GRACE_MS } from './deferredStop';
import { probeHttp } from './HealthCheck';

const log = getLogger();

/** How long an unload POST may take; Strata answers once the GPU is free. */
const UNLOAD_TIMEOUT_MS = 60_000;
/** An explicit stop waits for the server to leave its port before reporting success. */
export const STOP_TIMEOUT_MS = 90_000;
/** How long to wait for a started server to accept connections before giving up. */
export const START_TIMEOUT_MS = 240_000;
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
 * Local model servers Forge does not spawn but can unload (Strata): an
 * `openai-compatible` model with `unload_path`. A normal release keeps the
 * server up; explicit unload commands also run its configured stop command.
 * POSTing the path frees its GPU/RAM and it reloads on its next request. The
 * pool treats each one as a resident model, so every unload command reaches it
 * and it never shares VRAM with a llama.cpp/Ollama model this window loads.
 * See docs/plans/EXTERNAL_SERVER_UNLOAD_PLAN.md.
 */
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
    return model.provider === 'openai-compatible' && model.unload_path ? model : undefined;
  }

  isManaged(name: string): boolean {
    return this.managed(name) !== undefined;
  }

  /** Unknown counts as loaded: a server started by hand may hold VRAM. */
  isLoaded(name: string): boolean {
    return this.isManaged(name) && this.residency.get(name) !== 'unloaded';
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

  /**
   * Make sure the managed server is reachable before a request. If it is down
   * and the model has a `start_command`, launch it (detached, hidden, unref'd
   * so it survives the extension host) and wait until it accepts connections.
   * If it is down with no `start_command`, throw an actionable error. Called
   * from `prepareExternal` after local models are freed, so VRAM is available.
   */
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
    this.launchStart(model);
    const ready = await this.waitReachable(model.endpoint);
    if (!ready) {
      throw new Error(
        `"${name}" was started but did not become reachable at ${model.endpoint} ` +
          `within ${START_TIMEOUT_MS / 1000}s. It may still be starting — retry.`,
      );
    }
    log.info(`[ExternalModelServers] started "${name}"`);
  }

  /** Launch `start_command` detached so it survives the extension host. */
  private launchStart(model: ModelConfig): void {
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
      child.once?.('error', (error) =>
        log.error(`[ExternalModelServers] start command failed for "${model.name}"`, error),
      );
      child.unref();
      log.info(`[ExternalModelServers] launched start command for "${model.name}"`);
    } catch (error) {
      throw new Error(`Could not launch start command for "${model.name}": ${describe(error)}`);
    }
  }

  /** Poll the endpoint until it accepts connections or the timeout is reached. */
  private async waitReachable(endpoint: string): Promise<boolean> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      if ((await probeHttp(endpoint)).reachable) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    }
  }

  /** Unload every managed server that may hold memory; reports every failure. */
  async unloadAll(): Promise<void> {
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

  private markUnloadedUnlessReused(name: string, generation: number): void {
    if ((this.activityGeneration.get(name) ?? 0) === generation) {
      this.residency.set(name, 'unloaded');
    } else {
      log.info(
        `[ExternalModelServers] "${name}" was requested during unload; residency stays loaded`,
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

function isConnectionRefused(err: unknown): boolean {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  return (cause as { code?: string } | undefined)?.code === 'ECONNREFUSED';
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
