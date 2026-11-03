/**
 * The laptop half of the model starter (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md
 * Phase 2). The tests run against a REAL loopback listener rather than a stubbed
 * `fetch`, because what has to be proven is the wire: the port in the answer
 * replaces the port in the config, the model name sent is the DESKTOP's name,
 * and each failure class produces the message that tells the user what to fix.
 * A stubbed fetch would let a wrong URL shape or a swallowed status pass.
 */
import * as http from 'http';
import * as os from 'os';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  RemoteStarterClient,
  remoteStarterFor,
  releaseRemoteStarterLeases,
  setRemoteStarterClient,
  unloadModelOnRemote,
  wireRemoteStarter,
} from '../../src/llm/RemoteStarterClient';
import { listenLoopback } from '../support/listenLoopback';
import type { ForgeConfig } from '../../src/config/types';

type Handler = (
  payload: Record<string, unknown>,
  /** The route the laptop actually asked for, so a test can answer `/ensure`
   *  with a port and `/unload` with `unloaded` — the real starter does. */
  path: string,
) =>
  | Promise<{ status: number; body: Record<string, unknown> }>
  | { status: number; body: Record<string, unknown> };

const seen: Array<{ path: string; payload: Record<string, unknown> }> = [];

/** A desktop starter that answers like the real one, on a port of its own. */
async function startFakeStarter(handler: Handler): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      seen.push({ path, payload });
      void Promise.resolve(handler(payload, path)).then((answer) => {
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
  });
  const port = await listenLoopback(server);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}

/** A laptop config: the endpoint names the port this window guessed, and
 *  `remote_start` names the desktop's starter and the desktop's model name. */
function laptopConfig(starter: string, extra: Record<string, unknown> = {}): ForgeConfig {
  return {
    models: [
      {
        name: 'strata-laptop',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8090',
        model: 'qwen',
        remote_start: { starter, model: 'strata-iq3s' },
        ...extra,
      },
    ],
    active_model: 'strata-laptop',
    llama_server: {},
  } as ForgeConfig;
}

const okEnsure =
  (port: number, ttlMs = 600_000): Handler =>
  () => ({
    status: 200,
    body: {
      model: 'strata-iq3s',
      port,
      leaseId: 'lease-1',
      expiresAt: Date.now() + ttlMs,
      kind: 'managed-external',
    },
  });

function clientFor(
  config: ForgeConfig,
  isTurnActive: () => boolean = () => false,
): RemoteStarterClient {
  return new RemoteStarterClient(
    () => config,
    () => isTurnActive(),
  );
}

const modelOf = (config: ForgeConfig) => config.models[0];

describe('RemoteStarterClient', () => {
  let running: { close: () => void } | undefined;
  afterEach(() => {
    setRemoteStarterClient(undefined);
    running?.close();
    running = undefined;
    seen.length = 0;
  });

  it('replaces the guessed endpoint port with the one the starter reports', async () => {
    const starter = await startFakeStarter(okEnsure(8082));
    running = starter;
    const config = laptopConfig(starter.url);
    const client = clientFor(config);

    const { baseUrl } = await client.ensure(modelOf(config));
    // No /v1: OpenAIClient appends /v1/chat/completions itself.
    expect(baseUrl).toBe('http://127.0.0.1:8082');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/ensure');
    // The DESKTOP's name, not this machine's, and the laptop's hostname as client.
    expect(seen[0]!.payload).toEqual({ client: os.hostname(), model: 'strata-iq3s' });
  });

  it('an entry whose endpoint is the shared port keeps its model prefix', async () => {
    // The shape a laptop gets once model traffic comes through the starter's one
    // shared port: that port, plus the desktop's model name as a path prefix.
    // `/ensure` reports the same port back, so the prefix survives the rebuild
    // and OpenAIClient's `/v1/chat/completions` lands on the pass-through route
    // instead of on a model port that was never shared.
    let reportedPort = 0;
    const starter = await startFakeStarter(() => ({
      status: 200,
      body: {
        model: 'strata-iq3s',
        port: reportedPort,
        leaseId: 'lease-1',
        expiresAt: Date.now() + 600_000,
        kind: 'managed-external',
      },
    }));
    running = starter;
    reportedPort = Number(new URL(starter.url).port);
    const config = laptopConfig(starter.url, { endpoint: `${starter.url}/strata-iq3s` });
    const { baseUrl } = await clientFor(config).ensure(modelOf(config));
    expect(baseUrl).toBe(`http://127.0.0.1:${reportedPort}/strata-iq3s`);
    // What the model client will actually ask for, and the shape the desktop's
    // pass-through accepts.
    expect(`${baseUrl}/v1/chat/completions`).toContain('/strata-iq3s/v1/chat/completions');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/ensure');
  });

  it('reuses an unexpired lease without asking the desktop again', async () => {
    const starter = await startFakeStarter(okEnsure(8090));
    running = starter;
    const config = laptopConfig(starter.url);
    const client = clientFor(config);

    const first = await client.ensure(modelOf(config));
    const second = await client.ensure(modelOf(config));
    expect(second.baseUrl).toBe(first.baseUrl);
    expect(seen).toHaveLength(1);
  });

  it('re-ensures once the cached lease is past its expiry', async () => {
    const starter = await startFakeStarter(okEnsure(8090, 1));
    running = starter;
    const config = laptopConfig(starter.url);
    const client = clientFor(config);

    await client.ensure(modelOf(config));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.ensure(modelOf(config));
    expect(seen).toHaveLength(2);
  });

  it('renews while a turn is active on that model, and stops when it ends', async () => {
    // A 3 s lease makes the renewal due 1 s after the ensure, so the test does
    // not wait out a real 10-minute TTL.
    const starter = await startFakeStarter(okEnsure(8090, 3_000));
    running = starter;
    const config = laptopConfig(starter.url);
    let active = true;
    const client = clientFor(config, () => active);

    await client.ensure(modelOf(config));
    expect(seen).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    expect(seen).toHaveLength(2); // renewed: a long turn must not outlive its lease

    active = false;
    const beforeIdle = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    expect(seen.length).toBe(beforeIdle); // no renewals for a laptop that has stopped working
  });

  it('names the blocking model when the desktop answers 409', async () => {
    const starter = await startFakeStarter(() => ({
      status: 409,
      body: {
        error: 'Cannot load "maya-m2" beside strata-iq3s: a turn is running on it.',
        busyModel: ['strata-iq3s'],
      },
    }));
    running = starter;
    const config = laptopConfig(starter.url);
    await expect(clientFor(config).ensure(modelOf(config))).rejects.toThrow(
      /Desktop is busy running strata-iq3s; try again when its turn ends/,
    );
  });

  it('shows the reason when the desktop refuses the model with 422', async () => {
    const starter = await startFakeStarter(() => ({
      status: 422,
      body: { error: 'model "maya-m2" is not remotely servable', reason: 'port_not_shared' },
    }));
    running = starter;
    const config = laptopConfig(starter.url);
    const message = await failureMessage(clientFor(config).ensure(modelOf(config)));
    expect(message).toMatch(/port_not_shared.*shared_ports/s);
    // The LAN forwarder is a second way to reach the desktop, so the ACL is no
    // longer the only thing that can be refusing the laptop: a laptop at home
    // has to be told to check the firewall rule, not just the tailnet.
    expect(message).toMatch(/Tailscale ACL \(away\) or the desktop.s LAN firewall rule/);
    expect(message).toMatch(/\(at home\) lets .* reach it/);
  });

  it('passes the desktop own start failure through as written, 502', async () => {
    const starter = await startFakeStarter(() => ({
      status: 502,
      body: { error: '"strata-iq3s" was started but did not become reachable within 120s' },
    }));
    running = starter;
    const config = laptopConfig(starter.url);
    await expect(clientFor(config).ensure(modelOf(config))).rejects.toThrow(
      /could not start or load "strata-iq3s": .*did not become reachable within 120s/,
    );
  });

  it('says which name to fix when the desktop does not know the model, 404', async () => {
    const starter = await startFakeStarter(() => ({
      status: 404,
      body: { error: 'unknown model "strata-iq3s" — not in the desktop’s config' },
    }));
    running = starter;
    const config = laptopConfig(starter.url);
    await expect(clientFor(config).ensure(modelOf(config))).rejects.toThrow(
      /remote_start\.model must be the name THE DESKTOP uses/,
    );
  });

  it('reports an unreachable starter as a connectivity problem, not a model failure', async () => {
    const dead = await startFakeStarter(okEnsure(8090));
    const url = dead.url;
    dead.close(); // nothing is listening any more
    const config = laptopConfig(url);
    await expect(clientFor(config).ensure(modelOf(config))).rejects.toThrow(
      new RegExp(
        `Desktop model starter not reachable at ${url.replace(/\./g, '\\.')}.*is a Forge window open on the desktop.*Tailscale up`,
      ),
    );
  });

  it('a user Stop mid-ensure is a cancellation, not a desktop that is down', async () => {
    const starter = await startFakeStarter(
      () => new Promise<{ status: number; body: Record<string, unknown> }>(() => {}),
    );
    running = starter;
    const config = laptopConfig(starter.url);
    const ctrl = new AbortController();
    const pending = clientFor(config).ensure(modelOf(config), ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    await expect(pending).rejects.toThrow(/abort|Abort/i);
    // An already-cancelled signal must not be reported as a desktop that is down.
    let message = '';
    try {
      await clientFor(config).ensure(modelOf(config), abortedSignal());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toMatch(/not reachable/);
  });

  it('/unload asks the desktop and reports what it said', async () => {
    const starter = await startFakeStarter((_payload, route) =>
      route === '/unload'
        ? { status: 200, body: { unloaded: true } }
        : {
            status: 200,
            body: { port: 8090, leaseId: 'lease-1', expiresAt: Date.now() + 600_000 },
          },
    );
    running = starter;
    const config = laptopConfig(starter.url);
    const client = clientFor(config);
    await client.ensure(modelOf(config));
    const before = seen.length;
    expect(await client.unload(modelOf(config))).toEqual({ unloaded: true });
    expect(seen[before]!.path).toBe('/unload');
    // The lease is gone, so the next request must re-ensure.
    await client.ensure(modelOf(config));
    expect(seen[before + 1]!.path).toBe('/ensure');
  });

  it('/release gives up every lease and clears the cache', async () => {
    const starter = await startFakeStarter((payload) =>
      'model' in payload
        ? { status: 200, body: { port: 8090, expiresAt: Date.now() + 600_000, leaseId: 'l' } }
        : { status: 200, body: { released: ['strata-iq3s'] } },
    );
    running = starter;
    const config = laptopConfig(starter.url);
    const client = clientFor(config);
    await client.ensure(modelOf(config));
    await client.release();
    expect(seen.at(-1)!.path).toBe('/release');
    expect(seen.at(-1)!.payload).toEqual({ client: os.hostname() });
    await client.ensure(modelOf(config)); // cache cleared: it asks again
    expect(seen.filter((entry) => entry.path === '/ensure')).toHaveLength(2);
  });

  it('a failed release on deactivate never throws', async () => {
    const dead = await startFakeStarter(okEnsure(8090));
    const url = dead.url;
    running = dead;
    const config = laptopConfig(url);
    const client = clientFor(config);
    await client.ensure(modelOf(config));
    setRemoteStarterClient(client);
    dead.close(); // the desktop went away mid-shutdown
    // `deactivate()` awaits this on every window close, so a thrown error here
    // would hold the window open: it must resolve and log instead.
    await expect(releaseRemoteStarterLeases()).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  it('wireRemoteStarter installs a client that only serves remote_start models', () => {
    const turns = new Map<string, string>([['chat-1', 'strata-laptop@worker']]);
    setRemoteStarterClient(undefined);
    expect(() => remoteStarterFor(modelOf(laptopConfig('http://127.0.0.1:8798')))).toThrow(
      /no model starter client/,
    );
    wireRemoteStarter(() => laptopConfig('http://127.0.0.1:8798'), turns);
    const remote = modelOf(laptopConfig('http://127.0.0.1:8798'));
    expect(remoteStarterFor(remote)).toBeInstanceOf(RemoteStarterClient);
    expect(remoteStarterFor({ name: 'local', provider: 'llama.cpp' })).toBeUndefined();
  });

  it('unloadModelOnRemote answers undefined for a model this machine manages', async () => {
    const starter = await startFakeStarter(() => ({ status: 200, body: { unloaded: true } }));
    running = starter;
    wireRemoteStarter(() => laptopConfig(starter.url), new Map());
    expect(await unloadModelOnRemote('some-other-model')).toBeUndefined();
    expect(await unloadModelOnRemote('strata-laptop')).toEqual({ unloaded: true });
    expect(seen.map((entry) => entry.path)).toEqual(['/unload']);
  });
});

function abortedSignal(): AbortSignal {
  const ctrl = new AbortController();
  ctrl.abort();
  return ctrl.signal;
}

/** The message a rejected promise carries, so one test can assert two things
 *  about the same answer without asking the desktop twice. */
async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to be refused, and it was not');
}
