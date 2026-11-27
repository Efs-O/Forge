import { spawn } from 'child_process';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import { getLogger } from '../util/logger';
import {
  launchStopWatcher,
  type StopChild,
  type StopOnExitOptions,
  type StopSpawner,
} from './ExternalServerStopWatcher';
import {
  freeDecisionResidency,
  isConnectionRefused,
  probeExternalModelResidency,
  probeExternalResidencyEndpoints,
  readServedModelIds,
  selectorResidency,
  type ExternalResidency,
  type ExternalResidencyCandidate,
} from './ExternalModelResidencyProbe';
import {
  describeError,
  launchStartCommand,
  START_TIMEOUT_MS,
  stopServerAndAwaitPort,
  waitUntilReachable,
} from './externalServerProcess';
import { probeHttp } from './HealthCheck';
import { ResidencyPublisher } from './externalResidencyPublication';

/** The cold-start budget lives with the process control; readers name it here. */
export { START_POLL_MS, START_TIMEOUT_MS } from './externalServerProcess';

const log = getLogger();

/** How long an unload POST may take; Strata answers once the GPU is free. */
const UNLOAD_TIMEOUT_MS = 60_000;

export type SecretLookup = (key: string) => Promise<string | undefined>;

export type { StopChild, StopOnExitOptions, StopSpawner } from './ExternalServerStopWatcher';

export class ExternalServerBusyError extends Error {}

/**
 * Local servers Forge does not spawn but can unload (Strata): an
 * `openai-compatible` model with `unload_path`. A normal release keeps the
 * server up; explicit unload commands also run `stop_command`. POSTing the path
 * frees GPU/RAM and the next request reloads it. The pool treats each as
 * resident, so every unload reaches it; it never shares VRAM with a llama.cpp/
 * Ollama model or another managed server. See
 * docs/plans/EXTERNAL_SERVER_UNLOAD_PLAN.md.
 */
/** A managed external server: openai-compatible with an `unload_path` (Strata). */
export function isManagedExternalModel(
  model: Pick<ModelConfig, 'provider' | 'unload_path'>,
): boolean {
  return model.provider === 'openai-compatible' && !!model.unload_path;
}

export class ExternalModelServers {
  private readonly residency = new Map<string, ExternalResidency>();
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
  /** Publishes the machine-wide residency-change token when THIS window changes a
   *  managed server's residency (BL-032); a probe observation never publishes. */
  private readonly residencyPublisher = new ResidencyPublisher();

  constructor(
    private readonly getConfig: () => ForgeConfig,
    private readonly secret: SecretLookup,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly spawnImpl: StopSpawner = (command, args, options) =>
      spawn(command, [...args], options),
  ) {}

  /** Wire the machine-wide residency-change publisher (BL-032). Unwired means this
   *  window's changes never reach the token, and `residencyPublicationTrusted`
   *  reports that, so no caller trusts a residency map. */
  setResidencyChangeHook(hook: (() => void) | undefined): void {
    this.residencyPublisher.wire(hook);
  }

  /** Whether every residency change made here is visible to the other windows
   *  (`ResidencyPublisher.trusted`); false means no residency map may be trusted. */
  residencyPublicationTrusted(): boolean {
    return this.residencyPublisher.trusted();
  }

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
   * GPUs the server's engine uses. Read via `managed()`, which folds in the
   * resolver; `config.models`/`config.engines` miss engine-supplied values.
   * `undefined` means no cards were named, so it overlaps every server, as before.
   * `poolAcquisition.gpusOverlap` consumes this through `BackendPoolExternal`.
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

  /**
   * Loaded as far as this window has seen. Unlike `isLoaded`, unknown is NOT
   * loaded for the selector dot, so a server nobody used does not appear
   * resident. A matching server probe also confirms it.
   */
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
    this.residencyPublisher.publish();
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
      log.info(`[ExternalModelServers] "${name}" stopped outside this window`);
    }
    const residency = selectorResidency(result);
    if (residency === 'unloaded') {
      // A probe OBSERVING an unload publishes nothing: this window's map merely
      // caught up with the board, and publishing would invalidate the probe of
      // every other window that is mid-flight, including this window's own.
      this.markUnloadedUnlessReused(name, generation, 'residency refresh', false);
    } else if (residency === 'loaded' && (this.activityGeneration.get(name) ?? 0) === generation) {
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
      const residency = freeDecisionResidency(result);
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
      throw new Error(`Could not unload "${name}" (${url}): ${describeError(err)}`);
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
    await stopServerAndAwaitPort(this.spawnImpl, model, 'after explicit unload');
  }

  /**
   * Ensure reachable first; start `start_command` detached, hidden and unref'd
   * to survive the extension host. Without it, throw an actionable error. Called
   * after freeing local and other managed servers, with GPUs available.
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
    if ((await probeHttp(model.endpoint)).reachable) {
      // Reachable is not enough. A Strata launcher stays on its port after an
      // unload (`auto_load: true`), so switching from one model entry to another
      // on the same endpoint returned here and the launcher answered every
      // request with the model that was loaded before. Hand the port over.
      if (!(await this.takeSharedPort(name, model))) return;
    }
    if (!model.start_command?.length) {
      throw new Error(
        `"${name}" is not running (nothing is listening at ${model.endpoint}). ` +
          'Start it manually, or set start_command so Forge can start it.',
      );
    }
    // A command that cannot run (ENOENT, EACCES) fails asynchronously; stop
    // polling on it rather than wait out START_TIMEOUT_MS.
    let launchError: Error | undefined;
    launchStartCommand(this.spawnImpl, model, (error) => (launchError = error));
    const ready = await waitUntilReachable(model.endpoint, () => launchError !== undefined);
    if (launchError) {
      throw new Error(`Start command for "${name}" failed: ${describeError(launchError)}`);
    }
    if (!ready) {
      throw new Error(
        `"${name}" was started but did not become reachable at ${model.endpoint} ` +
          `within ${START_TIMEOUT_MS / 1000}s. It may still be starting — retry.`,
      );
    }
    log.info(`[ExternalModelServers] started "${name}"`);
  }

  /**
   * Whether `start_command` may run now. False means the server already answering
   * the endpoint is ours to use (it serves this model, or cannot be told apart).
   * True means another managed entry held the port and has now been stopped, so
   * the port is free. Throws when the server there belongs to no entry Forge can
   * stop, rather than answering the request with the wrong model.
   */
  private async takeSharedPort(name: string, model: ModelConfig): Promise<boolean> {
    const token = model.api_key_secret ? await this.secret(model.api_key_secret) : undefined;
    const served = await readServedModelIds(model.endpoint!, token, this.fetchImpl);
    if (served === undefined || model.model === undefined || served.includes(model.model)) {
      return false;
    }
    const owner = this.findPortOwner(model, served);
    if (!owner) {
      const ids = served.map((id) => `"${id}"`).join(', ');
      throw new Error(
        `"${name}" needs ${model.endpoint}, but the server there is serving ${ids}, ` +
          'and no model entry on that endpoint can stop it. Stop that server, then retry.',
      );
    }
    log.info(
      `[ExternalModelServers] "${owner.name}" holds ${model.endpoint}; ` +
        `stopping it to start "${name}"`,
    );
    const generation = this.activityGeneration.get(owner.name) ?? 0;
    await stopServerAndAwaitPort(this.spawnImpl, owner.model, 'to free its port');
    this.markUnloadedUnlessReused(owner.name, generation, 'port handover');
    return true;
  }

  /** The other managed entry that owns this endpoint: same endpoint (trailing
   *  slashes trimmed), its `model` among the served ids, and a `stop_command`
   *  that can take the port back. */
  private findPortOwner(
    model: ModelConfig,
    served: readonly string[],
  ): { name: string; model: ModelConfig } | undefined {
    const endpoint = model.endpoint!.replace(/\/+$/, '');
    for (const entry of this.getConfig().models) {
      if (entry.name === model.name) continue;
      const other = this.managed(entry.name);
      if (!other?.endpoint || !other.stop_command?.length) continue;
      if (other.endpoint.replace(/\/+$/, '') !== endpoint) continue;
      if (other.model === undefined || !served.includes(other.model)) continue;
      return { name: entry.name, model: other };
    }
    return undefined;
  }

  /** Unload every managed server that may hold memory; reports every failure.
   *  `names` replaces the residency map for a caller that cannot prove it current —
   *  the map is what it would otherwise iterate, and a stale one frees nothing. */
  async unloadAll(alreadyReconciled = false, names?: readonly string[]): Promise<void> {
    if (!alreadyReconciled) await this.reconcileForFree(this.managedNames());
    const results = await Promise.allSettled(
      (names ?? this.loadedNames()).map((n) => this.unload(n)),
    );
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

  /** `publish` is false where a probe merely OBSERVED the board: only a change
   *  this window caused may invalidate another window's in-flight probe (BL-032). */
  private markUnloadedUnlessReused(
    name: string,
    generation: number,
    operation = 'unload',
    publish = true,
  ): void {
    if ((this.activityGeneration.get(name) ?? 0) === generation) {
      this.residency.set(name, 'unloaded');
      if (publish) this.residencyPublisher.publish();
    } else {
      log.info(
        `[ExternalModelServers] "${name}" was requested during ${operation}; residency stays loaded`,
      );
    }
  }

  private launchStop(model: ModelConfig, leaseDir: string): StopChild | undefined {
    return launchStopWatcher(this.spawnImpl, model, leaseDir);
  }
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
