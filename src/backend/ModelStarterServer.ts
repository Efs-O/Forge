/**
 * The model starter: a loopback listener a laptop Forge calls to make a desktop
 * model answer (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md).
 *
 * Four routes and no others, and no key or token. That is safe only because
 * there is nothing here to do except start, load and unload models that are
 * already named in the DESKTOP's config: the input is a model name and a
 * client label, both checked against that config, and the commands run are the
 * `start_command`/`stop_command` values the desktop itself wrote. The worst a
 * compromised laptop can do is hold the GPU. `ModelStarterSurface.test.ts`
 * fails CI if a later phase adds a fifth route, binds beyond `127.0.0.1`, or
 * pulls chat/agent code in here — a "chat through the starter" convenience
 * route would ship a token-less way to spend the owner's API budget.
 *
 * It binds `127.0.0.1` only, like every Forge listener: `tailscale serve`
 * forwards the tailnet port to loopback, so the starter cannot tell a laptop
 * from a local process and does not try to. The trust boundary is the Tailscale
 * ACL plus Tailnet Lock, not anything in this file.
 *
 * The pass-through — `/<model name>/v1/<openai path>`, owned by
 * `ModelStarterPassThrough.ts` — is NOT the "chat through the starter" route
 * this header warns about. It answers no prompt and starts nothing: it decides
 * one thing, which loopback port to hand the request to, and that port comes
 * from the DESKTOP's config and pool, never from the request. Every model it
 * forwards to is one `remoteServability` already marks `remote: true`, so cloud
 * models, Ollama, CLI agents, unmanaged hand-started servers and Forge's own
 * service ports are refused before a byte is dialed. Those models were already
 * reachable, token-less, through their own `tailscale serve` shares; the
 * pass-through only puts them behind ONE share, so a new desktop model needs no
 * new share, no new ACL line and no `shared_ports` entry. Nothing keyed and
 * nothing billable became reachable that was not reachable before — which is why
 * `ModelStarterSurface.test.ts` still has the same job: the four control routes,
 * plus the pass-through's path shape and its target set.
 */

import * as http from 'http';
import { z } from 'zod';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import type { ForgeConfig } from '../config/types';
import { unloadModel } from './ControlModelLifecycle';
import type { EnsureResult } from './ControlServer';
import { buildStarterModelEntry, ensureForRemote, remoteServability } from './ModelStarterEnsure';
import { STARTER_PASSTHROUGH_BODY_BYTES, StarterPassThrough } from './ModelStarterPassThrough';
import type { ModelStarterLeases } from './ModelStarterLeases';
import type { BackendPool } from './BackendPool';
import type { ControlServer } from './ControlServer';
import { sendJson } from './httpJson';
import { getLogger } from '../util/logger';
import { createTailnetListener, type TailnetListener } from './TailnetListener';

const log = getLogger();

/** Every route the starter answers, in the shape `<method> <path>`. Anything
 *  else — including `/healthz`, `/chat` and `/agent/*` — is 404. A fifth entry
 *  here means someone widened a token-less listener; `ModelStarterSurface.test.ts`
 *  is what makes that a CI failure rather than a review catch. The pass-through
 *  is deliberately NOT a fifth entry: it is a family of paths resolved against
 *  the desktop's own config, and writing it here would make every path under `/`
 *  a route. Its shape is pinned separately, below. */
export const STARTER_ROUTES = [
  'GET /models',
  'POST /ensure',
  'POST /release',
  'POST /unload',
] as const;

/** The pass-through, spelled in the same shape as the routes above and pinned by
 *  `ModelStarterSurface.test.ts`: one model-name segment, then `/v1/`, then an
 *  OpenAI-compatible path. `starterPassThroughRoute` is what actually rules on a
 *  path; this is the shape it is not allowed to grow past. */
export const STARTER_PASSTHROUGH_SHAPE = '/<model name>/v1/<openai path>' as const;

/** A POST body here names one model and labels one client — nothing bigger can
 *  legitimately arrive, and the cap is what keeps a flood from being a cost. */
const STARTER_BODY_BYTES = 4 * 1024;
const ClientSchema = z.string().min(1).max(120);
const ModelSchema = z.string().min(1).max(200);
const EnsureSchema = z
  .object({ client: ClientSchema, model: ModelSchema })
  .strict()
  .refine((value) => value.model.trim().length > 0, 'model must not be blank');
const ReleaseSchema = z.object({ client: ClientSchema }).strict();
const UnloadSchema = EnsureSchema;

export { hostAllowed, isJsonContentType, originRefused } from './TailnetListener';

/** What `extension.ts` gets back: the three things the desktop needs to know
 *  about the starter, and the disposal it pushes into `context.subscriptions`. */
export interface ModelStarterWiring {
  dispose(): void;
  /** Re-run after every config reload: `enabled` opens or closes the listener,
   *  and closing it releases every lease, since nothing can renew it any more. */
  applyConfig(): void;
  /** Is a live remote lease protecting this model? OR'd into `stopOnExit`'s
   *  busy check, so closing the last desktop window leaves a laptop's model up. */
  hasLease(modelName: string): boolean;
}

export interface ModelStarterDeps {
  getConfig: () => ForgeConfig;
  pool: BackendPool;
  controlServer: ControlServer;
  leases: ModelStarterLeases;
}

/** Build the starter and open it if the config asks for it. Returns a wiring
 *  object even when `model_starter` is absent, so `extension.ts` has one shape
 *  to call and a reload that enables it later takes effect without re-activating
 *  the extension. */
export function wireModelStarter(
  getConfig: () => ForgeConfig,
  pool: BackendPool,
  controlServer: ControlServer,
  leases: ModelStarterLeases,
): ModelStarterWiring {
  const server = new ModelStarterServer({ getConfig, pool, controlServer, leases });
  server.applyConfig();
  return {
    dispose: () => server.dispose(),
    applyConfig: () => server.applyConfig(),
    hasLease: (modelName) => leases.hasLease(modelName),
  };
}

export class ModelStarterServer {
  private listener: TailnetListener | null = null;
  /** The pass-through forwarder, made with the server and closed with it. It
   *  holds every stream still being forwarded, and no part of a laptop's request
   *  can make it dial a port it was not told about. */
  private readonly passThrough: StarterPassThrough;

  constructor(private readonly deps: ModelStarterDeps) {
    this.passThrough = new StarterPassThrough({
      getConfig: () => this.deps.getConfig(),
      resolveModel: (requested) => this.resolveModel(requested),
      pool: this.deps.pool,
    });
  }

  applyConfig(): void {
    const starter = this.deps.getConfig().model_starter;
    if (!starter?.enabled) {
      this.close();
      // Nothing can renew a lease once the listener is gone, so holding them
      // would protect models the laptop is no longer able to reach.
      this.deps.leases.releaseAllLeases();
      return;
    }
    if (this.listener) return;
    this.listener = createTailnetListener({
      port: starter.port,
      routes: STARTER_ROUTES,
      maxBodyBytes: STARTER_BODY_BYTES,
      // Model traffic is not a 4 KB control body: it is a chat request that may
      // carry an image, and the answer arrives over minutes. These are the
      // settings the cloud relay uses for the same shape of traffic.
      rawMaxBodyBytes: STARTER_PASSTHROUGH_BODY_BYTES,
      requestTimeoutMs: 0,
      headersTimeoutMs: 60_000,
      matchRaw: (method, path) => this.passThrough.accepts(method, path),
      onRawRequest: (req, res) => this.passThrough.forward(req, res),
      label: 'ModelStarter',
      originError: 'Origin header is not accepted by the model starter',
      log,
      onListening: () => this.deps.leases.startWatching(),
      onClose: () => {
        this.deps.leases.stopWatching();
        // Nothing can renew a lease or answer a stream once the listener is
        // gone, so the streams go with it: a laptop that is no longer being
        // served stops generating on this desktop.
        this.passThrough.closeAll();
      },
      onRequest: (req, res, route, body) => this.handleRequest(req, res, route, body),
    });
  }

  dispose(): void {
    this.close();
    this.deps.leases.dispose();
  }

  /**
   * What this window bound, or null when it is waiting for the port. There is
   * no production consumer today: it is how a test can tell "bound" from
   * "another window owns it", and it is the only way to assert the loopback
   * bind without reading the source. Kept narrow on purpose — a wider accessor
   * would invite a fifth route that needs a port to report.
   */
  boundAddress(): { address: string; port: number } | null {
    return this.listener?.boundAddress() ?? null;
  }

  private close(): void {
    this.listener?.dispose();
    this.listener = null;
  }

  /** Route the shared listener's guarded request to the starter surface. */
  private async handleRequest(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (route === 'GET /models') return this.listModels(res);
    switch (route) {
      case 'POST /ensure':
        return await this.ensure(res, body);
      case 'POST /release':
        return this.release(res, body);
      case 'POST /unload':
        return await this.unload(res, body);
      default:
        return sendJson(res, 404, { error: `no route for ${route}` });
    }
  }

  private listModels(res: http.ServerResponse): void {
    const config = this.deps.getConfig();
    const starter = config.model_starter;
    if (!starter) return sendJson(res, 404, { error: 'model_starter is not configured' });
    sendJson(res, 200, {
      // `shared_port` is the port model traffic for a laptop arrives on: the
      // starter's own, because the pass-through forwards `/<model>/v1/...` to the
      // port the model is on one loopback hop away. A laptop needs this number in
      // the same read it needs the model list in, because it is what its
      // `endpoint` has to name — and a desktop build that does not send it is how
      // `Forge: Connect to my desktop` knows to tell the owner to update Forge
      // here rather than write entries that 404 on every request.
      shared_port: starter.port,
      models: config.models.map((model) =>
        buildStarterModelEntry(model, {
          config,
          starter,
          pool: this.deps.pool,
          leases: this.deps.leases,
        }),
      ),
    });
  }

  private async ensure(res: http.ServerResponse, body: Record<string, unknown>): Promise<void> {
    const parsed = EnsureSchema.safeParse(body);
    if (!parsed.success) return this.refuseParse(res, parsed.error);
    const { client, model } = parsed.data;
    const target = this.resolveModel(model);
    if ('status' in target) return sendJson(res, target.status, target.body);
    const config = this.deps.getConfig();
    const starter = config.model_starter;
    if (!starter) return sendJson(res, 404, { error: 'model_starter is not configured' });
    const entry = config.models.find((item) => item.name === target.name)!;
    const servability = remoteServability(mergeGroupsIntoModel(config, entry), config, starter);
    if (!servability.remote) {
      // Refused BEFORE anything is loaded or evicted, so a laptop reading its
      // own config wrong cannot cost the desktop a model it was using.
      return sendJson(res, 422, {
        error: `"${target.name}" cannot be served from the model starter (${servability.reason}).`,
        reason: servability.reason,
      });
    }
    const outcome = await ensureForRemote({
      ctx: this.deps.controlServer.lifecycleContext(),
      pool: this.deps.pool,
      leases: this.deps.leases,
      client,
      model: target.name,
      servability,
    });
    sendJson(res, outcome.status, outcome.body);
  }

  private release(res: http.ServerResponse, body: Record<string, unknown>): void {
    const parsed = ReleaseSchema.safeParse(body);
    if (!parsed.success) return this.refuseParse(res, parsed.error);
    sendJson(res, 200, { released: this.deps.leases.releaseClient(parsed.data.client) });
  }

  private async unload(res: http.ServerResponse, body: Record<string, unknown>): Promise<void> {
    const parsed = UnloadSchema.safeParse(body);
    if (!parsed.success) return this.refuseParse(res, parsed.error);
    const { client, model } = parsed.data;
    const target = this.resolveModel(model);
    if ('status' in target) return sendJson(res, target.status, target.body);
    // This client's lease goes first, whatever happens next: it asked for the
    // model to be unloaded, so it has given up its claim on it.
    const lease = this.deps.leases.find(client, target.name);
    if (lease) this.deps.leases.release(lease);
    // After that, anything still pinning it is not this client: a desktop turn,
    // or another client's lease. Both refuse rather than unload under them.
    if (this.deps.pool.isBusy(target.name)) {
      return sendJson(res, 409, {
        error:
          `"${target.name}" is in use by a desktop turn or another client's lease — ` +
          'it was not unloaded. Your own lease is released; send a prompt to re-ensure.',
        busyModel: [target.name],
      });
    }
    const ctx = this.deps.controlServer.lifecycleContext();
    const result = await ctx.serialize(() => unloadModel(ctx, target.name));
    sendJson(res, result.status, result.body as Record<string, unknown>);
  }

  /** Resolve through the control server's own rules (alias, @profile, F7 fuzzy)
   *  and then require the name to exist in THIS machine's config — a laptop
   *  naming a model it invented gets 404, never a guess. */
  private resolveModel(requested: string): { name: string } | EnsureResult {
    const resolved = this.deps.controlServer.lifecycleContext().resolveBase(requested);
    if ('status' in resolved) return resolved;
    if (!this.deps.getConfig().models.some((model) => model.name === resolved.name)) {
      return {
        status: 404,
        body: { error: `unknown model "${requested}" — not in the desktop's config` },
      };
    }
    return { name: resolved.name };
  }

  private refuseParse(res: http.ServerResponse, error: z.ZodError): void {
    const issue = error.issues[0];
    sendJson(res, 400, {
      error: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid request body',
    });
  }
}
