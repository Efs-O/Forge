import * as http from 'http';
import * as net from 'net';
import { errText, readJson, sendJson } from './httpJson';

const REBIND_INTERVAL_MS = 30_000;

export interface TailnetListenerLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TailnetListenerOptions {
  port: number;
  routes: readonly string[];
  maxBodyBytes: number;
  label: string;
  originError?: string;
  log: TailnetListenerLog;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  /** A path `routes` does not have, which this listener will still serve — as a
   *  stream, not as a parsed body. Asked only AFTER the exact-route check has
   *  already failed, so a listener that does not supply it 404s exactly what it
   *  always did. The model starter's pass-through needs it: a chat body has to
   *  reach the model byte for byte and the answer has to stream back, and
   *  `readJson` can do neither (it parses and re-serialises the request, and
   *  holds the whole reply in memory). */
  matchRaw?(method: string, path: string): boolean;
  /** Hand the live request to the raw handler. It owns the response and the
   *  unread body stream; the listener has already applied the Host, Origin,
   *  content-type and content-length guards and has read NOTHING of the body. */
  onRawRequest?(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
  ): void | Promise<void>;
  /** The cap for a streamed body, checked against `content-length` before the
   *  handler is handed the stream. Absent means `maxBodyBytes`. */
  rawMaxBodyBytes?: number;
  onRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    body: Record<string, unknown>,
  ): void | Promise<void>;
  onListening?(): void;
  onClose?(): void;
  onRejected?(route: string, status: number, startedAt: number, bytesIn: number): void;
}

export interface TailnetListener {
  dispose(): void;
  boundAddress(): { address: string; port: number } | null;
}

/** Accept IP literals and localhost, refusing Host names that enable DNS rebinding. */
export function hostAllowed(header: string | undefined): boolean {
  if (!header) return false;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(header);
  if (bracketed) return net.isIP(bracketed[1]!) !== 0;
  const withoutPort = header.includes(']') ? header : header.replace(/:\d+$/, '');
  if (withoutPort.toLowerCase() === 'localhost') return true;
  return net.isIP(withoutPort) !== 0;
}

/**
 * Accept only this listener's own loopback Host at the exact port it is bound
 * to. Stricter than `hostAllowed` (which any IP literal passes): a foreign name
 * or a port that is not ours is refused, so a web page cannot read the control
 * API through a DNS rebinding to `evil.example`. Case-insensitive on the host.
 */
export function loopbackHostAllowed(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const host = header.toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function originRefused(header: string | undefined): boolean {
  return header !== undefined;
}

export function isJsonContentType(header: string | undefined): boolean {
  return /^application\/json\s*(;.*)?$/i.test((header ?? '').trim());
}

/** One loopback-only listener pattern for services exposed by `tailscale serve`. */
export function createTailnetListener(options: TailnetListenerOptions): TailnetListener {
  let server: http.Server | null = null;
  let rebindTimer: NodeJS.Timeout | undefined;
  let loggedBindCode: string | undefined;
  let disposed = false;

  const close = (): void => {
    if (rebindTimer) clearTimeout(rebindTimer);
    rebindTimer = undefined;
    const previous = server;
    server = null;
    previous?.close();
    options.onClose?.();
  };

  /**
   * A streamed route: the same guards as every other route, the body cap
   * checked against `content-length` rather than counted on the way in, and then
   * the request handed over UNREAD. A streamed body cannot be capped by counting
   * bytes once the handler has begun answering, so an undeclared length is the
   * handler's problem — and what it forwards to is the desktop's own loopback
   * model server, not a metered service.
   */
  const handleRaw = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    startedAt: number,
    bytesIn: number,
  ): Promise<void> => {
    const method = req.method ?? 'GET';
    // A streamed route is a model request, and a model request is GET or POST.
    // Anything else stays a 404, as it was before this hook existed.
    if (method !== 'GET' && method !== 'POST') {
      options.onRejected?.(route, 404, startedAt, bytesIn);
      req.resume();
      return sendJson(res, 404, { error: `no route for ${route}` });
    }
    // The same content-type rule as the JSON routes: it forces a CORS preflight
    // that a browser cannot complete, so a web page cannot post here.
    if (method === 'POST' && !isJsonContentType(req.headers['content-type'])) {
      options.onRejected?.(route, 415, startedAt, bytesIn);
      req.resume();
      return sendJson(res, 415, { error: 'content-type must be application/json' });
    }
    const cap = options.rawMaxBodyBytes ?? options.maxBodyBytes;
    const declaredLength = Number(req.headers['content-length'] ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > cap) {
      options.onRejected?.(route, 413, startedAt, bytesIn);
      req.resume();
      return sendJson(res, 413, { error: `body must be at most ${cap} bytes` });
    }
    await options.onRawRequest!(req, res, route);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const startedAt = Date.now();
    const contentLength = Number(req.headers['content-length'] ?? '');
    const bytesIn = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
    try {
      if (!hostAllowed(req.headers.host)) {
        options.onRejected?.(
          `${req.method ?? 'GET'} ${(req.url ?? '/').split('?')[0]}`,
          403,
          startedAt,
          bytesIn,
        );
        return sendJson(res, 403, {
          error: 'Host header must be an IP address or localhost (DNS-rebinding guard)',
        });
      }
      if (originRefused(req.headers.origin)) {
        options.onRejected?.(
          `${req.method ?? 'GET'} ${(req.url ?? '/').split('?')[0]}`,
          403,
          startedAt,
          bytesIn,
        );
        return sendJson(res, 403, {
          error: options.originError ?? 'Origin header is not accepted by this listener',
        });
      }
      const method = req.method ?? 'GET';
      const path = (req.url ?? '/').split('?')[0];
      const route = `${method} ${path}`;
      if (!options.routes.includes(route)) {
        if (!options.onRawRequest || !options.matchRaw?.(method, path)) {
          options.onRejected?.(route, 404, startedAt, bytesIn);
          return sendJson(res, 404, { error: `no route for ${route}` });
        }
        return await handleRaw(req, res, route, startedAt, bytesIn);
      }
      if (method === 'GET') return await options.onRequest(req, res, route, {});
      if (!isJsonContentType(req.headers['content-type'])) {
        options.onRejected?.(route, 415, startedAt, bytesIn);
        return sendJson(res, 415, { error: 'content-type must be application/json' });
      }
      const declaredLength = Number(req.headers['content-length'] ?? '');
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBodyBytes) {
        options.onRejected?.(route, 413, startedAt, bytesIn);
        req.resume();
        return sendJson(res, 413, {
          error: `body must be at most ${options.maxBodyBytes} bytes`,
        });
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(req, options.maxBodyBytes);
      } catch (error) {
        const message = errText(error);
        const status = /too large/i.test(message) ? 413 : 400;
        options.onRejected?.(route, status, startedAt, bytesIn);
        return sendJson(res, status, { error: message });
      }
      await options.onRequest(req, res, route, body);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: errText(error) });
      else res.destroy(error instanceof Error ? error : undefined);
    }
  };

  const bind = (): void => {
    if (disposed || server || rebindTimer) return;
    const next = http.createServer((req, res) => void handle(req, res));
    if (options.requestTimeoutMs !== undefined) next.requestTimeout = options.requestTimeoutMs;
    if (options.headersTimeoutMs !== undefined) next.headersTimeout = options.headersTimeoutMs;
    next.on('connection', (socket) => socket.setTimeout(0));
    next.on('error', (error: NodeJS.ErrnoException) => {
      if (server !== next || disposed) return;
      server = null;
      const code = error.code ?? 'unknown';
      if (loggedBindCode !== code) {
        loggedBindCode = code;
        if (code === 'EADDRINUSE') {
          options.log.warn(
            `[${options.label}] 127.0.0.1:${options.port} is taken by another Forge window — ` +
              `this window is not the ${options.label === 'ModelStarter' ? 'model starter ' : ''}` +
              `owner; retrying every ${REBIND_INTERVAL_MS / 1000}s.`,
          );
        } else {
          options.log.error(
            `[${options.label}] could not bind 127.0.0.1:${options.port}: ${errText(error)}`,
          );
        }
      }
      rebindTimer = setTimeout(() => {
        rebindTimer = undefined;
        bind();
      }, REBIND_INTERVAL_MS);
      rebindTimer.unref?.();
    });
    next.listen(options.port, '127.0.0.1', () => {
      if (server !== next || disposed) return;
      loggedBindCode = undefined;
      options.log.info(
        `[${options.label}] listening on http://127.0.0.1:${options.port} ` +
          `(${options.routes.length} routes${options.label === 'ModelStarter' ? ', no token' : ''})`,
      );
      options.onListening?.();
    });
    server = next;
  };

  bind();
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      close();
    },
    boundAddress: () => {
      const address = server?.address();
      return !address || typeof address === 'string'
        ? null
        : { address: address.address, port: address.port };
    },
  };
}
