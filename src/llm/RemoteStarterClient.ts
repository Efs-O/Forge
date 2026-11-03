/**
 * The laptop half of the model starter (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md
 * Phase 2): before a request to a `remote_start` model, ask the desktop's
 * starter to start or load it, and use the port that answer reports.
 *
 * Two problems this solves that a laptop cannot solve by itself. It cannot
 * START a desktop server (`start_command` runs on the machine Forge runs on),
 * and it cannot know which llama.cpp slot port a quant landed on — the desktop
 * hands out 8080-8083 in whatever order slots free up. The starter's `/ensure`
 * answers both: it starts the server if it is down and returns the port it is
 * answering on.
 *
 * The second half is the LEASE. Each `POST /ensure` holds the model on the
 * desktop for `lease_ttl_s`, and this client renews it every third of that while
 * its own turn is running — without renewal, a long generation (200K tokens at
 * 40 t/s is about 83 minutes) would outlive the lease and the desktop would
 * evict or stop the server mid-turn. Renewal stops the moment the turn does, so
 * an abandoned model is freed by TTL rather than by someone noticing.
 *
 * The third is WHICH ADDRESS to ask (docs/plans/LAPTOP_LAN_ACCESS_PLAN.md):
 * `remote_start.starter` may list the desktop's LAN forwarder and its tailnet
 * address. Choosing among them, remembering which one answered and re-choosing
 * when the laptop moves or the address goes quiet is `StarterRouter`'s job in
 * `RemoteStarterRoute.ts`; this file says what to ask of the address it picks,
 * and keeps the lease. A config with one address never probes and behaves
 * exactly as it did before this file grew.
 *
 * No silent fallback: every failure names its cause, because a laptop that
 * quietly used a stale port would fail at the model server instead, where the
 * message says nothing about the desktop.
 */

import * as os from 'os';
import { getLogger } from '../util/logger';
import { starterUrls } from '../config/modelSchema';
import { baseUrlWithPort, failureReasonOf, postToStarter } from './RemoteStarterHttp';
import {
  allStarterFailedMessage,
  networkFingerprint,
  StarterRouter,
  type RouteRequest,
  type StarterFailure,
  type StarterRoute,
} from './RemoteStarterRoute';
import type { ForgeConfig, ModelConfig } from '../config/types';

const log = getLogger();

/**
 * How long one `/ensure` may take. The desktop's own ceilings add up: 120 s
 * waiting for a started server to accept connections (`START_TIMEOUT_MS`,
 * ExternalModelServers.ts) plus 60 s waiting for a loaded model to answer
 * (`READINESS_TIMEOUT_MS`, ControlServer.ts), plus the load itself. 300 s is
 * that sum with margin. It is a constant, not a config field, because the
 * number is set by the desktop's code rather than by taste — a shorter timeout
 * would report a successful start as a failure.
 */
const ENSURE_TIMEOUT_MS = 300_000;
/** A release during `deactivate()`: one round trip is enough, and a window that
 *  is closing must not wait on a machine that may be asleep. */
const RELEASE_TIMEOUT_MS = 2_000;
/** Renew a third of its life before a lease lapses, so one lost request does
 *  not drop it — three attempts per lease life before it expires. */
const RENEW_DIVISOR = 3;

/** A lease this window holds on the desktop, plus the address it was earned
 *  through: renew, `/unload` and `/release` all go back the way it came. */
interface CachedLease {
  /** `http://<winning starter host>:<port the starter reported>` — no `/v1`,
   *  because OpenAIClient appends `/v1/chat/completions` itself. */
  baseUrl: string;
  /** Epoch ms the desktop sent back. Past it, the entry is stale and re-earned. */
  expiresAt: number;
  leaseId: string;
  /** The starter that answered `/ensure`, whose host `baseUrl` was built from,
   *  and whose `/release` and `/unload` this lease now belongs to. A lease
   *  earned through an address this window no longer uses is not the same route
   *  any more, so it is re-earned rather than reused. */
  starter: string;
}

/**
 * The laptop half of the starter. One instance per Forge window, created at
 * activation and set as the module's active client (the same shape
 * `setExternalRequestHook` uses, because `resolveCloudRequestTarget` is a free
 * function and cannot be handed a collaborator).
 */
export class RemoteStarterClient {
  private readonly cache = new Map<string, CachedLease>();
  private readonly renewTimers = new Map<string, NodeJS.Timeout>();
  /** Sent as `client` on every route. The starter uses it only to log and to
   *  keep one lease per client — it is not an identity and grants nothing. */
  private readonly clientLabel = os.hostname();
  /** Which address to dial is the router's whole job. This window tells it the
   *  clock, the fetch and the network it is on; the router tells this window
   *  which address to use and when it has to start choosing again. */
  private routerInstance: StarterRouter | undefined;

  constructor(
    private readonly getConfig: () => ForgeConfig,
    /** Does THIS window have a live turn on that model? Fed by `activeTurnModels`. */
    private readonly isTurnActive: (modelName: string) => boolean,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Which network this window is on. Injectable so a test can say "the
     *  laptop has just moved to the café" without moving it. */
    private readonly fingerprint: () => string = networkFingerprint,
  ) {}

  /**
   * Make the model answer and report its port. A cached, unexpired lease is
   * reused without a request — this runs before EVERY request to the model, and
   * a round trip per prompt would be pure overhead. Reusing it also arms the
   * renew timer, so the heartbeat keeps running while a turn does.
   *
   * The address the `/ensure` goes to is the router's choice; the only decision
   * made here is whether a cached lease may be reused, which depends on the
   * lease (expiry, and the address it was earned through) as well as on the
   * route (rule d).
   */
  async ensure(model: ModelConfig, signal?: AbortSignal): Promise<{ baseUrl: string }> {
    const remote = model.remote_start;
    if (!remote) throw new Error(`"${model.name}" has no remote_start block`);
    if (!model.endpoint) {
      throw new Error(`"${model.name}" has no endpoint to rebuild a port onto`);
    }
    const call = { urls: starterUrls(remote), signal };
    let route = await this.routeFor(call);
    const cached = this.cache.get(model.name);
    if (cached && cached.expiresAt > this.now() && cached.starter === route.starter) {
      // Reuse it with no request when the route is fresh — or when there is
      // only one address, because rule (d) exists to switch routes and a
      // one-address config has nowhere to switch to: probing it would add a
      // request to behaviour that has not changed since 0.17.84.
      if (this.router.contactIsFresh() || call.urls.length === 1) {
        this.armRenew(model.name);
        return { baseUrl: cached.baseUrl };
      }
      // (d) The lease is in date, but the address that earned it has not
      // answered for a minute, so re-verify it before trusting the cached base
      // URL: a café network that hands out the desktop's LAN address is
      // invisible to the fingerprint, and without this the laptop would keep
      // dialing a machine that is not there for the rest of the lease.
      route = await this.router.reverifyRoute(call);
      if (!route.leasesMustDrop) {
        this.armRenew(model.name);
        return { baseUrl: cached.baseUrl };
      }
      // The address that earned it is gone, so every base URL built on its host
      // goes with it — this model re-ensures through the new winner below.
      this.dropAllLeases();
    } else if (cached) {
      // Expired, or earned through an address this window no longer uses: its
      // base URL names a host the laptop may not be able to reach at all now,
      // so it is re-earned rather than reused.
      this.dropLease(model.name);
    }
    const answer = await this.postThroughRoute(
      '/ensure',
      { client: this.clientLabel, model: remote.model },
      ENSURE_TIMEOUT_MS,
      remote,
      call,
      { route },
    );
    const port = Number(answer.body.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(
        `the desktop answered /ensure for "${model.name}" without a usable port: ${String(answer.body.port)}`,
      );
    }
    const expiresAt = Number(answer.body.expiresAt);
    this.cache.set(model.name, {
      baseUrl: baseUrlWithPort(model.endpoint, port, answer.starter),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.now() + 60_000,
      leaseId: typeof answer.body.leaseId === 'string' ? answer.body.leaseId : '',
      starter: answer.starter,
    });
    this.armRenew(model.name);
    return { baseUrl: this.cache.get(model.name)!.baseUrl };
  }

  /** The config entry named `modelName`, when it is a `remote_start` model. */
  remoteStartModel(modelName: string): ModelConfig | undefined {
    const model = this.getConfig().models.find((entry) => entry.name === modelName);
    return model?.remote_start ? model : undefined;
  }

  /**
   * Ask the desktop to unload this model. Its lease is released first even when
   * the unload is refused — the desktop drops the caller's lease before checking
   * who else holds the model — so the cache is cleared either way and the next
   * request re-ensures.
   */
  async unload(model: ModelConfig): Promise<{ unloaded: boolean }> {
    const remote = model.remote_start;
    if (!remote) throw new Error(`"${model.name}" has no remote_start block`);
    const call = { urls: starterUrls(remote) };
    // Resolved before the call so a network move drops the stale leases here,
    // at the same point in every entry path, and so the address to try first is
    // read after that drop: a lease earned through an address the new network
    // cannot reach is renewed — or unloaded — through the one it can.
    const route = await this.routeFor(call);
    const leaseStarter = this.cache.get(model.name)?.starter;
    let answer: { body: Record<string, unknown> };
    try {
      // The desktop that holds the lease is the one that has to be told; with no
      // lease, the route this window would use now is.
      answer = await this.postThroughRoute(
        '/unload',
        { client: this.clientLabel, model: remote.model },
        ENSURE_TIMEOUT_MS,
        remote,
        call,
        { route, preferredStarter: leaseStarter },
      );
    } finally {
      // The desktop drops this client's lease before it checks who else holds
      // the model, so the lease is gone whether the unload happened or not — the
      // next request must re-ensure either way.
      this.dropLease(model.name);
    }
    return { unloaded: answer.body.unloaded === true };
  }

  /**
   * Give up every lease this window holds. `deactivate()` calls it best effort;
   * a missed release simply lapses by TTL on the desktop. One POST per DISTINCT
   * starter that holds a lease: with a list in `remote_start.starter` the leases
   * can have been earned on two addresses, and only the one holding a lease can
   * free it. A failure is thrown rather than swallowed —
   * `releaseRemoteStarterLeases` turns it into the "they lapse by TTL" log line.
   */
  async release(): Promise<void> {
    const starters = [...new Set([...this.cache.values()].map((lease) => lease.starter))];
    const failures: StarterFailure[] = [];
    try {
      for (const starter of starters) {
        try {
          await this.dial(
            '/release',
            { client: this.clientLabel },
            RELEASE_TIMEOUT_MS,
            undefined,
            starter,
            undefined,
          );
        } catch (error) {
          // Keep going: a desktop that will not answer one address still has to
          // be told about the others, and every lease is cleared below either
          // way.
          failures.push({ url: starter, reason: failureReasonOf(error) });
        }
      }
      if (failures.length > 0) throw new Error(allStarterFailedMessage(failures));
    } finally {
      for (const name of [...this.renewTimers.keys()]) this.dropRenewTimer(name);
      this.cache.clear();
    }
  }

  /** The address to use, with the leases a network move took with it. Rule (b):
   *  a different fingerprint means the laptop moved, so every cached base URL
   *  points at a host this window may no longer reach and all of them go before
   *  anything is re-chosen. The desktop keeps one lease per client label, so
   *  re-ensuring through the new address renews the same lease and nothing
   *  needs releasing. */
  private async routeFor(call: RouteRequest): Promise<StarterRoute> {
    const route = await this.router.routeFor(call);
    if (route.leasesMustDrop) this.dropAllLeases();
    return route;
  }

  /** Place one call through the address the router chose, letting it apply rule
   *  (c): an unreachable failure is re-chosen from the first configured address
   *  and retried once. `preferredStarter` is the address to try first when the
   *  call answers for a lease earned through another one — renew, `/unload` and
   *  `/release` go back the way the lease came. */
  private postThroughRoute(
    path: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    remote: { model: string } | undefined,
    call: RouteRequest,
    options: { route?: StarterRoute | undefined; preferredStarter?: string | undefined } = {},
  ): Promise<{ body: Record<string, unknown>; starter: string }> {
    return this.router.call({
      ...call,
      route: options.route,
      preferredStarter: options.preferredStarter,
      dial: (starter) => this.dial(path, payload, timeoutMs, call.signal, starter, remote),
    });
  }

  /** One POST to one address, with this window's fetch and label. The caller
   *  chose the address: this never picks one and never tries another. */
  private dial(
    path: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    starter: string,
    remote: { model: string } | undefined,
  ): Promise<Record<string, unknown>> {
    return postToStarter(
      this.fetchImpl,
      path,
      payload,
      timeoutMs,
      signal,
      starter,
      remote,
      this.clientLabel,
    );
  }

  /** Arm the heartbeat for one leased model, at most once per model. It stops by
   *  itself when no turn is active: the lease then expires on its own, which is
   *  the intended behaviour for a laptop that has stopped working. */
  private armRenew(modelName: string): void {
    if (this.renewTimers.has(modelName)) return;
    const entry = this.cache.get(modelName);
    if (!entry) return;
    const delay = Math.max(1_000, Math.floor((entry.expiresAt - this.now()) / RENEW_DIVISOR));
    const timer = setTimeout(() => {
      this.renewTimers.delete(modelName);
      if (!this.isTurnActive(modelName)) return;
      const model = this.getConfig().models.find((entry2) => entry2.name === modelName);
      if (!model?.remote_start) return;
      void this.renewNow(model).catch((error: unknown) =>
        log.warn(
          `[RemoteStarterClient] renew "${modelName}" failed; the lease expires on its own: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }, delay);
    timer.unref?.();
    this.renewTimers.set(modelName, timer);
  }

  /** One heartbeat: re-POST /ensure (never the cache — the cache would answer
   *  without touching the desktop, which is the whole point of a renew) and
   *  re-arm from the expiry the desktop actually granted. */
  private async renewNow(model: ModelConfig): Promise<void> {
    const remote = model.remote_start!;
    const call = { urls: starterUrls(remote) };
    const route = await this.routeFor(call);
    const answer = await this.postThroughRoute(
      '/ensure',
      { client: this.clientLabel, model: remote.model },
      ENSURE_TIMEOUT_MS,
      remote,
      call,
      { route, preferredStarter: this.cache.get(model.name)?.starter },
    );
    const entry = this.cache.get(model.name);
    if (!entry) return; // released while this renew was in flight
    const port = Number(answer.body.port);
    if (model.endpoint && Number.isInteger(port) && port > 0) {
      entry.baseUrl = baseUrlWithPort(model.endpoint, port, answer.starter);
      // The address that renewed it is the one its `/release` and `/unload` go
      // to, so the lease follows the route instead of staying on the old host.
      entry.starter = answer.starter;
    }
    const expiresAt = Number(answer.body.expiresAt);
    if (Number.isFinite(expiresAt)) entry.expiresAt = expiresAt;
    this.armRenew(model.name);
  }

  private dropLease(modelName: string): void {
    this.cache.delete(modelName);
    this.dropRenewTimer(modelName);
  }

  /** Every cached lease goes at once: each base URL was built on the host of the
   *  address that earned it, so after the laptop moves networks none of them
   *  names a machine this window can still reach. */
  private dropAllLeases(): void {
    for (const name of [...this.cache.keys()]) this.dropLease(name);
  }

  private dropRenewTimer(modelName: string): void {
    const timer = this.renewTimers.get(modelName);
    if (!timer) return;
    clearTimeout(timer);
    this.renewTimers.delete(modelName);
  }

  private get router(): StarterRouter {
    return (this.routerInstance ??= new StarterRouter(this.now, this.fetchImpl, this.fingerprint));
  }
}

// ── the window's client ───────────────────────────────────────────────────────

let activeClient: RemoteStarterClient | undefined;

/** Create and install this window's starter client. `activeTurnModels` is
 *  `extension.ts`'s conversation → model map, so renewal follows the turn
 *  exactly: it starts when a turn on a remote model starts and stops when that
 *  turn ends, and an idle laptop lets its leases lapse rather than holding the
 *  desktop's GPU. A turn on `base@profile` is still a turn on `base` — the
 *  lease, the pin and this check all key on the base model, so the profile
 *  suffix must not hide it. */
export function wireRemoteStarter(
  getConfig: () => ForgeConfig,
  activeTurnModels: ReadonlyMap<string, string>,
): void {
  setRemoteStarterClient(
    new RemoteStarterClient(getConfig, (modelName) =>
      [...activeTurnModels.values()].some(
        (active) => active === modelName || active.startsWith(`${modelName}@`),
      ),
    ),
  );
}

export function setRemoteStarterClient(client: RemoteStarterClient | undefined): void {
  activeClient = client;
}

/** The client for a `remote_start` model. `undefined` for every other model.
 *  A missing client with a `remote_start` entry is a wiring bug, and it is
 *  reported as one rather than answered with the endpoint in the config — that
 *  endpoint is the port this window guessed, which is the bug this file exists
 *  to remove. */
export function remoteStarterFor(model: ModelConfig): RemoteStarterClient | undefined {
  if (!model.remote_start) return undefined;
  if (!activeClient) {
    throw new Error(
      `"${model.name}" sets remote_start, but this window has no model starter client. ` +
        'It is created at activation — run "Forge: Reload Window" after adding remote_start ' +
        'to config.yaml.',
    );
  }
  return activeClient;
}

/**
 * `/unloadModel` for a model this machine cannot unload itself: ask the desktop,
 * and report its answer. `undefined` for every other model, so the caller's
 * local release path is unchanged. Throws with the desktop's own reason, because
 * "the desktop refused to unload it" is not the same as "nothing was loaded".
 */
export async function unloadModelOnRemote(
  modelName: string,
): Promise<{ unloaded: boolean } | undefined> {
  const client = activeClient;
  if (!client) return undefined;
  const model = client.remoteStartModel(modelName);
  if (!model) return undefined;
  return remoteStarterFor(model)!.unload(model);
}

/** `deactivate()`: give up every lease this window held. Never throws — the
 *  window is closing, and a missed release lapses by TTL on the desktop. */
export async function releaseRemoteStarterLeases(): Promise<void> {
  const client = activeClient;
  if (!client) return;
  try {
    await client.release();
  } catch (error) {
    log.warn(
      `[RemoteStarterClient] could not release remote leases on exit; they lapse by TTL on the ` +
        `desktop: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
