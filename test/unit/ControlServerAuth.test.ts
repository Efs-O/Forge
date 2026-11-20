/**
 * Auth guard for the localhost control server (docs/plans/FRESH_INSTALL_REVIEW_FIXES_PLAN.md).
 *
 * Today any web page can POST /chat (a billed cloud call) or /ensure//unload to
 * 127.0.0.1:8799, and a DNS rebinding can read /models. These tests pin the
 * guard: every route refuses a foreign Host or a browser Origin/Sec-Fetch-Site;
 * the six model routes demand the control token; model POSTs must be JSON; while
 * /healthz stays open and /agent/* keeps its own per-window bearer and accepts
 * the text/plain body forge.sh posts.
 *
 * Requests are made with `http.request` (not fetch) so a test can set the exact
 * `Host`, `Origin`, `Sec-Fetch-Site` and `Content-Type` headers a real browser
 * or a rebinding client would send — undici would add or refuse some of them.
 */
import * as http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlServer } from '../../src/backend/ControlServer';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { BackendController } from '../../src/backend/BackendController';
import type { ForgeConfig } from '../../src/config/types';
import type {
  ControlServerRecord,
  IControlServerRegistry,
} from '../../src/backend/ControlServerRegistry';
import type { AgentRoutes } from '../../src/backend/agentRoutes';
import type { ChatProxyFn } from '../../src/llm/ControlChatProxy';
import { findFreeLoopbackPort } from '../support/listenLoopback';

const pool: IBackendPool = {
  acquire: async (): Promise<BackendController> => {
    throw new Error('not used by the auth guard');
  },
  release: async () => {},
  stopAll: async () => {},
  refreshExternalResidency: async () => {},
  applyForgeConfig: () => {},
  showConsole: () => {},
  isAnyReady: () => false,
  loadedModelNames: () => [],
  isBusy: () => false,
  loadedModelsExcept: () => [],
  isLoaded: () => false,
};

function makeConfig(port: number): ForgeConfig {
  return {
    models: [{ name: 'grok', provider: 'xai', api_key_secret: 'forge.xai' }],
    active_model: 'grok',
    llama_server: {},
    control_server: { enabled: true, port },
  } as ForgeConfig;
}

interface Response {
  status: number;
  body: Record<string, unknown> | undefined;
  text: string;
}

/** One HTTP request with full control over the headers, against the bound port.
 *  Omit `Host` to let Node send the correct `127.0.0.1:<port>`; set it to
 *  something else to exercise the rebinding guard. */
function request(
  port: number,
  req: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = http.request(
      {
        host: '127.0.0.1',
        port,
        method: req.method ?? 'GET',
        path: req.path,
        headers: req.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown> | undefined;
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            body = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body, text });
        });
        res.on('error', reject);
      },
    );
    client.on('error', reject);
    if (req.body !== undefined) client.write(req.body);
    client.end();
  });
}

/** A fake `/agent/*` handler that records the request headers it received and
 *  answers with a fixed status, so a test can prove the guard handed the request
 *  through untouched rather than rejecting it with 403/415. */
function fakeAgentRoutes(
  status: number,
  seen: { headers?: http.IncomingHttpHeaders },
): AgentRoutes {
  return {
    setEnabled: () => {},
    onListening: () => {},
    dispose: () => {},
    handle: async (req: http.IncomingMessage, res: http.ServerResponse) => {
      seen.headers = req.headers;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reached: true }));
    },
  } as unknown as AgentRoutes;
}

const started: ControlServer[] = [];

async function startServer(
  deps: { chatProxy?: ChatProxyFn; agentRoutes?: AgentRoutes } = {},
): Promise<{
  server: ControlServer;
  port: number;
  token: string;
  published: ControlServerRecord | undefined;
}> {
  const port = await findFreeLoopbackPort();
  let published: ControlServerRecord | undefined;
  const registry: IControlServerRegistry = {
    publish: (record) => {
      published = record;
    },
    removeIfOwned: () => {},
  };
  const server = new ControlServer(pool, makeConfig(port), {
    registry,
    probe: async () => true,
    ...(deps.chatProxy ? { chatProxy: deps.chatProxy } : {}),
    ...(deps.agentRoutes ? { agentRoutes: deps.agentRoutes } : {}),
  });
  started.push(server);
  server.start();
  // Wait until the listener answers /healthz (open, no token) — by then the
  // listen callback has already published the discovery record.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await request(port, { path: '/healthz' })).status === 200) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { server, port, token: server.token, published };
}

const MISSING_TOKEN = {
  error: 'missing or stale token: read it from control-server.json (it changes when Forge restarts)',
};

describe('ControlServer auth guard', () => {
  afterEach(() => {
    for (const server of started.splice(0)) server.dispose();
  });

  it('publishes the control token in the discovery record, equal to the server token', async () => {
    const { server, published } = await startServer();
    expect(published?.token).toBe(server.token);
    expect(published?.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a foreign Host with 403 forbidden host', async () => {
    const { port, token } = await startServer();
    const res = await request(port, {
      path: '/models',
      headers: { Host: `evil.example:${port}`, authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden host' });
  });

  it('refuses a browser Origin with 403 browser requests are refused', async () => {
    const { port, token } = await startServer();
    const res = await request(port, {
      path: '/models',
      headers: { Origin: 'http://evil.example', authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'browser requests are refused' });
  });

  it('refuses Sec-Fetch-Site: cross-site with 403 browser requests are refused', async () => {
    const { port, token } = await startServer();
    const res = await request(port, {
      path: '/models',
      headers: { 'sec-fetch-site': 'cross-site', authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'browser requests are refused' });
  });

  it('POST /chat with the token but text/plain content-type is 415', async () => {
    const { port, token } = await startServer({
      chatProxy: async () => ({ content: '', reasoning: '', finishReason: 'stop' }),
    });
    const res = await request(port, {
      method: 'POST',
      path: '/chat',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      body: JSON.stringify({ model: 'grok', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'Content-Type must be application/json' });
  });

  it('GET /models without a token is 401 with the exact message', async () => {
    const { port } = await startServer();
    const res = await request(port, { path: '/models' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(MISSING_TOKEN);
  });

  it('GET /models with the wrong token is 401', async () => {
    const { port } = await startServer();
    const res = await request(port, {
      path: '/models',
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(MISSING_TOKEN);
  });

  it('GET /healthz with no token is 200', async () => {
    const { port } = await startServer();
    const res = await request(port, { path: '/healthz' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /models with the token and the right Host is 200', async () => {
    const { port, token } = await startServer();
    const res = await request(port, {
      path: '/models',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('models');
  });

  it('allows Sec-Fetch-Site: none with the token', async () => {
    const { port, token } = await startServer();
    const res = await request(port, {
      path: '/models',
      headers: { 'sec-fetch-site': 'none', authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('POST /agent/* keeps its own bearer and its text/plain body — no 403, no 415', async () => {
    const seen: { headers?: http.IncomingHttpHeaders } = {};
    const { port } = await startServer({ agentRoutes: fakeAgentRoutes(200, seen) });
    const res = await request(port, {
      method: 'POST',
      path: '/agent/notify',
      headers: {
        authorization: 'Bearer window-token',
        'content-type': 'text/plain; charset=utf-8',
      },
      body: 'hello',
    });
    // The guard hands /agent/* to agentRoutes untouched: not 403 (Host/Origin),
    // not 401 (control token), not 415 (JSON content-type).
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(415);
    expect(seen.headers?.authorization).toBe('Bearer window-token');
    expect(seen.headers?.['content-type']).toBe('text/plain; charset=utf-8');
  });
});
