import { spawn, type SpawnOptions } from 'child_process';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import { getLogger } from '../util/logger';
import { deferredStopInvocation, STOP_GRACE_MS } from './deferredStop';

const log = getLogger();

/** How long an unload POST may take; Strata answers once the GPU is free. */
const UNLOAD_TIMEOUT_MS = 60_000;

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
 * `openai-compatible` model with `unload_path`. The server process stays up;
 * POSTing the path frees its GPU/RAM and it reloads on its next request. The
 * pool treats each one as a resident model, so every unload command reaches it
 * and it never shares VRAM with a llama.cpp/Ollama model this window loads.
 * See docs/plans/EXTERNAL_SERVER_UNLOAD_PLAN.md.
 */
export class ExternalModelServers {
  private readonly residency = new Map<string, Residency>();
  /** Incremented before each request so a late unload completion cannot erase it. */
  private readonly activityGeneration = new Map<string, number>();

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
