/**
 * The pass-through: model traffic on the starter's ONE shared port
 * (docs/plans/V1_FINISH_PLAN.md lane 3 phase 3.1).
 *
 * Until now every model port a laptop might use had to be shared by
 * `tailscale serve`, named in the Tailscale ACL and mirrored in
 * `model_starter.shared_ports` — so adding a desktop model on a new port meant
 * a new share, a new ACL line and a new config entry, all kept in step by hand.
 * This route carries model traffic through the starter's own port instead:
 * `/<model name>/v1/<openai path>` is forwarded byte for byte to the loopback
 * port THAT model is answering on right now, so one share serves every model
 * the desktop is willing to serve.
 *
 * It is NOT the "chat through the starter" route `ModelStarterServer`'s header
 * warns about. It answers no prompt and starts no inference: it decides one
 * thing — which loopback port to hand the request to — and that port comes from
 * the DESKTOP's config and pool, never from the request. Every model it will
 * forward to is one `remoteServability` already calls `remote: true`, so a cloud
 * model (whose traffic would cost the owner an API bill), an Ollama daemon, a
 * CLI agent, an unmanaged hand-started server and Forge's own service ports
 * (control server, cloud relay, starter, Ollama's 11434) are refused before a
 * byte is forwarded. What is reachable is exactly what was already reachable
 * through each model's own `tailscale serve` share — the same token-less local
 * servers, now behind one port. Nothing keyed, nothing billable, and no new way
 * to spend the owner's GPU beyond the load a laptop could already ask for.
 */

import * as http from 'http';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import type { ForgeConfig } from '../config/types';
import type { EnsureResult } from './ControlServer';
import { remoteServability, type RemoteServability, type StarterPool } from './ModelStarterEnsure';
import { errText, sendJson } from './httpJson';
import { getLogger } from '../util/logger';

const log = getLogger();

/** The largest body a laptop may push through this route: 32 MB, because that
 *  is the cap the SAME request already has on the desktop's cloud relay
 *  (`cloud_relay.max_body_mb`, whose schema default is 32). The largest request
 *  a laptop sends today is a chat request carrying an attached image — base64
 *  inside the JSON body — and that body is what arrives here, so a cap below
 *  the relay's would cut off pictures the laptop is already entitled to send.
 *  The starter's control routes keep their 4 KB: a `/ensure` body names one
 *  model and labels one client, and nothing bigger can legitimately arrive. */
export const STARTER_PASSTHROUGH_BODY_BYTES = 32 * 1024 * 1024;

/** A model name as the path may carry it: the charset `config.yaml` names use,
 *  taken VERBATIM — no percent-decoding, no fuzzy match, no separator — so a
 *  path segment can never smuggle a folder, a port or an alias. A name outside
 *  this charset 404s, which is the answer the starter has always given for a
 *  name it does not have. */
const MODEL_NAME = /^[A-Za-z0-9_.+-]{1,200}$/;

/** The OpenAI-compatible paths a laptop's client uses: `/v1/chat/completions`
 *  (the chat), `/v1/models` (what the server reports) and
 *  `/v1/messages/count_tokens` (the `token_count: count_tokens` tokenizer), and
 *  anything else under `/v1/`. The Ollama routes (`/api/chat`, `/api/generate`)
 *  are deliberately absent: Ollama is never remotely servable, so a laptop has
 *  no reason to ask for them, and answering them would put an unguarded path in
 *  front of a daemon that is not this model's. */
const OPENAI_PATH = /^\/v1\/[A-Za-z0-9_./-]{2,}$/;

/** Headers that belong to one connection and must not be copied to the next:
 *  `host` is rewritten to the loopback port actually dialed, and Node sets the
 *  rest itself from the body it is given. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'host',
] as const;

export interface PassThroughRoute {
  /** The model name exactly as it appears in the path — the DESKTOP's name,
   *  because the path prefix is what the laptop's `endpoint` carries. */
  model: string;
  /** What to ask the model server for: `/v1/<tail>`, the model prefix removed.
   *  The query string is not part of it — it is forwarded separately so the
   *  model server sees exactly what the laptop asked for. */
  upstreamPath: string;
  /** `?…` as it arrived, or an empty string. */
  query: string;
}

/** The pass-through's shape as a pure function, so the guard can be tested
 *  without a listener: `/gemma-iq3s/v1/chat/completions` gives the model and
 *  the upstream path. Everything else — `/models`, `/chat`, `/api/chat`,
 *  `/v1/models` (a path with no model), `/a/b`, `..` traversal, a name that
 *  looks like a port — gives null, which is the 404 the starter has always
 *  answered for a route it does not have. */
export function starterPassThroughRoute(url: string): PassThroughRoute | null {
  const path = url.split('?')[0] ?? '';
  const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
  const secondSlash = path.indexOf('/', 1);
  if (secondSlash < 0) return null;
  const name = path.slice(1, secondSlash);
  const rest = path.slice(secondSlash);
  // `.` and `..` are not model names: they are folder navigation, and a
  // navigation segment must not become a model name that then 404s quietly.
  if (name === '.' || name === '..') return null;
  if (!MODEL_NAME.test(name)) return null;
  if (!OPENAI_PATH.test(rest) || rest.includes('..')) return null;
  return { model: name, upstreamPath: rest, query };
}

/** What the forwarder reads, and nothing else: the same three decisions
 *  `POST /ensure` makes. It never loads a model, never pins, never starts a
 *  server, and never resolves a key — a pass-through request carries no key,
 *  because the models it serves take none. */
export interface PassThroughDeps {
  getConfig(): ForgeConfig;
  /** The starter's own name rules (alias, `@profile`, F7 fuzzy, then "must be
   *  in THIS machine's config"), reused so the pass-through and `/ensure` can
   *  never disagree about which name is real. */
  resolveModel(requested: string): { name: string } | EnsureResult;
  /** `modelPort` is the port a loaded llama.cpp slot answers on, and `isLoaded`
   *  says whether a managed external's server is up. Both are the desktop's own
   *  knowledge: no part of the request can move either one. */
  pool: StarterPool & { isLoaded(modelName: string): boolean };
}

/** One request still being forwarded, so the log and the tests can name it. */
interface Forwarded {
  upstream: http.ClientRequest;
  model: string;
  port: number;
  startedAt: number;
}

/**
 * The pass-through's forwarder. One instance per starter listener, created with
 * it and thrown away with it: `closeAll()` is what ends every stream when the
 * listener goes away — sharing off, a config reload that turns the starter off,
 * or this window closing — so no stream can outlive the window that was
 * serving it.
 */
export class StarterPassThrough {
  /** Every upstream request still in flight, aborted together by `closeAll()`.
   *  Kept in a Set rather than per-request because the abort that matters most
   *  (the listener closing) has to reach all of them at once. */
  private readonly inFlight = new Set<Forwarded>();

  constructor(private readonly deps: PassThroughDeps) {}

  /** Does this path look like a pass-through request? Asked by the shared
   *  listener after its exact-route check has already failed, so a listener
   *  without this hook 404s exactly what it always did. */
  accepts(method: string, path: string): boolean {
    return (method === 'GET' || method === 'POST') && starterPassThroughRoute(path) !== null;
  }

  /** Forward one request byte for byte and stream the answer back unbuffered.
   *  Resolves once the upstream request has been made; the bytes keep flowing
   *  afterwards, and the handler owns the response from here on. */
  async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const route = starterPassThroughRoute(req.url ?? '/');
    if (!route) {
      const method = req.method ?? 'GET';
      return this.refuse(req, res, 404, {
        error: `no route for ${method} ${(req.url ?? '/').split('?')[0]}`,
      });
    }
    const resolved = this.deps.resolveModel(route.model);
    if ('status' in resolved) return this.refuse(req, res, resolved.status, resolved.body);
    const config = this.deps.getConfig();
    const starter = config.model_starter;
    if (!starter) return this.refuse(req, res, 404, { error: 'model_starter is not configured' });
    const entry = config.models.find((model) => model.name === resolved.name);
    if (!entry) {
      return this.refuse(req, res, 404, {
        error: `unknown model "${route.model}" — not in the desktop's config`,
      });
    }
    const servability = remoteServability(mergeGroupsIntoModel(config, entry), config, starter);
    if (!servability.remote) {
      // Refused BEFORE anything is dialed, so a laptop reading its own config
      // wrong cannot reach a cloud endpoint, the Ollama daemon or one of Forge's
      // own service ports through this listener.
      return this.refuse(req, res, 422, {
        error:
          `"${resolved.name}" cannot be served through the model starter ` +
          `(${servability.reason}).`,
        reason: servability.reason,
      });
    }
    const port = this.currentPort(resolved.name, servability);
    if (port === null) {
      // The laptop always ensures first, so this is the rare case: a desktop
      // turn, an eviction or a reload took the model away underneath it. The
      // answer is the same in every case — `/ensure` will load it and report
      // the new port, and the laptop's next request goes through that.
      return this.refuse(req, res, 409, {
        error: `"${resolved.name}" is not loaded on the desktop: call /ensure first.`,
        model: resolved.name,
      });
    }
    this.pipe(req, res, route, resolved.name, port);
  }

  /** A refusal of a streamed route. The body is not being forwarded, so it has
   *  to be drained: a Node server that ends a response with the request still
   *  unread closes the connection, and the laptop would see a reset instead of
   *  the reason it needs in order to fix its config. */
  private refuse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') req.resume();
    sendJson(res, status, body);
  }

  /** Every stream this window was still forwarding, ended at once. Called when
   *  the listener closes; a destroyed upstream stops generating on the desktop,
   *  which is what "sharing off" is supposed to do. */
  closeAll(): void {
    for (const forwarded of [...this.inFlight]) {
      this.inFlight.delete(forwarded);
      if (!forwarded.upstream.destroyed) forwarded.upstream.destroy();
    }
  }

  /** How many requests are still being forwarded — what a test reads to prove
   *  `closeAll()` and a laptop hang-up actually reached the desktop. */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /** The port this model answers on RIGHT NOW: the slot the pool handed it when
   *  it loaded (llama.cpp), or the fixed endpoint port the desktop's own config
   *  names (a server this window manages). Never a port the request said: the
   *  Host header, the path and the query are all unread here. */
  private currentPort(name: string, servability: RemoteServability): number | null {
    if (!this.deps.pool.isLoaded(name)) return null;
    return servability.kind === 'managed-external'
      ? servability.port
      : (this.deps.pool.modelPort?.(name) ?? null);
  }

  /** The forwarding itself: copy the request out, copy the answer back, and
   *  wire both ends of the disconnect so nobody keeps generating for a client
   *  that has gone. */
  private pipe(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: PassThroughRoute,
    model: string,
    port: number,
  ): void {
    const upstream = http.request({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: `${route.upstreamPath}${route.query}`,
      headers: upstreamHeaders(req, port),
      agent: false,
    });
    const forwarded: Forwarded = { upstream, model, port, startedAt: Date.now() };
    this.inFlight.add(forwarded);
    const finish = (outcome: string): void => {
      log.info(
        `[ModelStarter] pass-through ${model} -> 127.0.0.1:${port} ${outcome} ` +
          `duration_ms=${Date.now() - forwarded.startedAt}`,
      );
    };
    const abortUpstream = (): void => {
      if (!upstream.destroyed) upstream.destroy();
    };
    // The laptop stopped sending, or stopped reading: either way the desktop has
    // no reason to keep generating. Without this an abandoned stream runs to the
    // end of a long turn and holds the GPU for a chat nobody is reading.
    req.once('aborted', abortUpstream);
    res.once('close', () => {
      if (!res.writableEnded) abortUpstream();
    });
    upstream.once('error', (error: Error) => {
      this.inFlight.delete(forwarded);
      // A refused or reset upstream is the desktop's problem, not the laptop's
      // guess: answer with what the desktop said, in the shape the laptop's
      // starter client already turns into a message.
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 502, {
          error:
            `the desktop's model server on 127.0.0.1:${port} did not answer ` +
            `${route.upstreamPath}: ${errText(error)}`,
          model,
        });
      } else if (!res.destroyed && !res.writableEnded) {
        res.destroy(error);
      }
      finish(`error ${errText(error)}`);
    });
    upstream.once('close', () => {
      this.inFlight.delete(forwarded);
    });
    upstream.once('response', (up) => {
      const status = up.statusCode ?? 502;
      if (!res.headersSent && !res.destroyed) res.writeHead(status, responseHeaders(up));
      up.on('error', (error: Error) => {
        if (!res.destroyed && !res.writableEnded) res.destroy(error);
      });
      up.on('end', () => {
        if (!res.destroyed && !res.writableEnded) res.end();
        finish(`status ${status} completed`);
      });
      // `pipe` rather than buffering: a 200K-token answer arrives over minutes
      // and the laptop has to see each token as it lands.
      if (res.destroyed) {
        up.destroy();
        finish('client gone before the answer started');
        return;
      }
      up.pipe(res);
    });
    if (req.method === 'GET' || req.method === 'HEAD') {
      upstream.end();
      return;
    }
    req.pipe(upstream);
  }
}

/** The request headers to copy, with `host` rewritten to the port actually
 *  dialed. `accept-encoding` is copied on purpose: the answer goes back exactly
 *  as it arrived, so a compressed body stays compressed. */
function upstreamHeaders(req: http.IncomingMessage, port: number): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || (HOP_BY_HOP as readonly string[]).includes(name)) continue;
    headers[name] = value;
  }
  headers.host = `127.0.0.1:${port}`;
  return headers;
}

/** The answer's headers, minus the ones that belong to the desktop's own
 *  connection. `content-length` and `content-encoding` stay: the body is
 *  copied unchanged, so what the model server said about it is still true. */
function responseHeaders(up: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(up.headers)) {
    if (value === undefined || (HOP_BY_HOP as readonly string[]).includes(name)) continue;
    headers[name] = value;
  }
  return headers;
}
