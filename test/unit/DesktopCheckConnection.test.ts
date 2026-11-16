/**
 * `Forge: Check connection` (docs/plans/V1_FINISH_PLAN.md lane 3 phase 3.4,
 * acceptance criterion 8): the walk down the laptop's own path, and the message
 * that names the FIRST broken link for each of the five failure points.
 *
 * Two invariants hold the file together:
 *
 * - **The check starts nothing.** The green path runs against the REAL starter
 *   surface from `test/support/modelStarterHarness.ts` — production
 *   `remoteServability` and `buildStarterModelEntry`, not a fourth fake — and the
 *   assertions are the pool's own counters and the fake model servers' request
 *   logs: no pin taken, no external prepared, no model server touched, and the
 *   relay asked for `GET /v1/models` only. A "check" that loaded a model to prove
 *   it could would fail here, not in the owner's GPU bill.
 * - **It stops at the first broken link.** Every test that expects a stop also
 *   counts the requests made afterwards and asserts nothing was dialled: a laptop
 *   whose Tailscale is down does not get three probes against an address its own
 *   tailnet does not have.
 *
 * `tailscale` is never run here (the lane rule): the CLI is injected, so links 1
 * and 2 are driven by JSON this file writes. The field names in that JSON are the
 * ones the installed CLI really returns (Tailscale 1.104): `BackendState`,
 * `CurrentTailnet.MagicDNSSuffix`, and `Peer` as an OBJECT keyed by node key,
 * whose entries carry `DNSName` (`"desktop.example-tailnet.ts.net."`, trailing
 * dot), `HostName`, `TailscaleIPs` and `Online` — there is no `NodeName`, and
 * this machine is the top-level `Self`, never an entry in `Peer`. Tailnet
 * addresses (100.x) are dialled
 * only through an injected `fetch`, because this machine IS a desktop with real
 * listeners on its loopback ports that a test must not reach.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import {
  runCheck,
  registerDesktopCheckConnectionCommands,
  type DesktopCheckDeps,
} from '../../src/vscode/desktopCheckConnection';
import { DESKTOP_CHECK_COMMAND } from '../../src/vscode/desktopConnect';
import {
  startPassThroughStarter,
  startFakeModelServer,
  type FakeModelServer,
} from '../support/modelStarterHarness';
import { findFreeLoopbackPort } from '../support/listenLoopback';

const ui = vi.hoisted(() => ({
  handlers: {} as Record<string, () => Promise<unknown>>,
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, fn: unknown) => {
      ui.handlers[id] = fn as () => Promise<unknown>;
      return { dispose(): void {} };
    },
  },
  window: {
    // `util/logger.ts` builds its output channel when the module loads, so the
    // mock has to provide one before anything under test can be imported.
    createOutputChannel: () => ({
      appendLine: () => {},
      append: () => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  // A local window: `remoteWindowKind.ts` must not read a remote kind here.
  env: { remoteName: undefined },
}));

/** A `tailscale status --json` this file controls. `Peer` is the shape the CLI
 *  really returns: an object keyed by node key, whose entries name themselves
 *  with a trailing-dot `DNSName` and a `HostName`, never a `NodeName`. The
 *  caller's `name` below is that DNS name, so what the check reports is the
 *  first label of it, exactly as it reads off a real tailnet. */
function statusJson(
  options: {
    state?: string;
    tailnet?: string;
    peers?: Array<{ name: string; ips: string[]; online: boolean }>;
  } = {},
): string {
  const suffix = options.tailnet ?? 'example-tailnet.ts.net';
  const peerMap: Record<string, unknown> = {};
  (options.peers ?? []).forEach((peer, index) => {
    const dnsName = peer.name.endsWith('.') ? peer.name : `${peer.name}.${suffix}.`;
    peerMap[`nodekey:${index}`] = {
      HostName: (dnsName.split('.')[0] ?? peer.name).toUpperCase(),
      DNSName: dnsName,
      TailscaleIPs: peer.ips,
      Online: peer.online,
    };
  });
  return JSON.stringify({
    Version: '1.104.2-test',
    BackendState: options.state ?? 'Running',
    CurrentTailnet: { MagicDNSSuffix: suffix },
    Peer: peerMap,
  });
}

/** A port nothing is listening on: bind one, read it, let go of it. */
async function freePort(): Promise<number> {
  return findFreeLoopbackPort();
}

/** The laptop's config: two models that come from the desktop and one cloud model
 *  that dials its relay. Every name here is one the harness's desktop really
 *  reports, so the green path is green for a reason rather than by accident —
 *  `withRefusals` below adds the two names that are not. */
function laptopConfig(starterUrl: string, relayUrl: string, sharedPort: number): ForgeConfig {
  const dialed = (name: string, context: number): Record<string, unknown> => ({
    name,
    provider: 'openai-compatible',
    endpoint: `http://127.0.0.1:${sharedPort}/${name}`,
    num_ctx: context,
    remote_start: { starter: [starterUrl], model: name },
  });
  return {
    models: [
      dialed('gemma-iq3s', 131072),
      dialed('strata-iq3s', 262144),
      { name: 'grok-code-fast', provider: 'openai-compatible', endpoint: relayUrl },
    ],
    active_model: 'gemma-iq3s',
    llama_server: {},
    control_server: { enabled: true, port: 8799 },
  } as unknown as ForgeConfig;
}

/** The two names that make the fifth link fail, both of them the desktop's own
 *  answer rather than a test's invention: `llama3` exists on the desktop and is
 *  marked `remote: false` with `ollama_not_shared`, and `typo-iq3s` is not
 *  reported at all — the two ways a laptop can be pointed at a model it cannot
 *  get, which the plan's "a named model fails to ensure" has to cover. */
function withRefusals(config: ForgeConfig): ForgeConfig {
  const starter = (config.models[0] as { remote_start: { starter: string[] } }).remote_start.starter;
  return {
    ...config,
    models: [
      ...(config.models as Array<Record<string, unknown>>),
      {
        name: 'llama3',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:1/v1',
        remote_start: { starter, model: 'llama3' },
      },
      {
        name: 'typo-iq3s',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:1/v1',
        remote_start: { starter, model: 'typo-iq3s' },
      },
    ],
  } as unknown as ForgeConfig;
}

/** Every `remote_start` entry dialling the same list of starter addresses, so a
 *  test can say "this laptop has two addresses and neither answers" — or "the
 *  first is dead and the last is the desktop" — without repeating the entry
 *  shape. `RemoteStarterRoute` probes all but the last, so two addresses is the
 *  smallest config that makes the probe run. */
function withStarters(config: ForgeConfig, urls: string[]): ForgeConfig {
  return {
    ...config,
    models: config.models.map((model) =>
      model.remote_start
        ? { ...model, remote_start: { ...model.remote_start, starter: urls } }
        : model,
    ),
  } as unknown as ForgeConfig;
}

/** A `fetch` that answers by URL, so a tailnet address can "answer" without this
 *  machine having one. Every call is recorded, which is how the tests that expect
 *  the walk to stop can prove nothing was dialled after the broken link. */
function fakeFetch(answers: Record<string, () => Response>, log: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    log.push(url);
    const answer = answers[url];
    if (!answer) {
      return Promise.reject(
        Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } }),
      );
    }
    return answer();
  }) as unknown as typeof fetch;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const starterRows = (extra: Array<Record<string, unknown>> = []): Response =>
  json({
    shared_port: 8798,
    models: [
      { name: 'gemma-iq3s', remote: true },
      { name: 'strata-iq3s', remote: true },
      { name: 'llama3', remote: false, reason: 'ollama_not_shared' },
      ...extra,
    ],
  });

let tailscaleCalls: string[][] = [];
function fakeTailscale(answer: () => Promise<string>): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    tailscaleCalls.push(args);
    return answer();
  };
}

let desktop: Awaited<ReturnType<typeof startPassThroughStarter>> | undefined;
let relay: FakeModelServer | undefined;
afterEach(async () => {
  tailscaleCalls = [];
  await relay?.close();
  relay = undefined;
  await desktop?.close();
  desktop = undefined;
});

describe('Forge: Check connection', () => {
  it('every link answers, and nothing was started to make that true', async () => {
    desktop = await startPassThroughStarter();
    relay = await startFakeModelServer();
    const starterUrl = `http://127.0.0.1:${desktop.starterPort}`;
    const config = laptopConfig(starterUrl, `http://127.0.0.1:${relay.port}`, desktop.starterPort);
    const dead = await freePort();
    const deps: DesktopCheckDeps = {
      // Two addresses, so `RemoteStarterRoute`'s probe really runs: the first is
      // a port nothing answers on, and the last is never probed but dialled for
      // real — the rule that keeps away mode from paying for one round trip twice.
      getConfig: () =>
        withStarters(config, [`http://127.0.0.1:${dead}`, `http://127.0.0.1:${desktop.starterPort}`]),
      runTailscale: fakeTailscale(async () => statusJson({ peers: [] })),
      fetchImpl: fetch,
      relayPort: relay.port,
    };
    const message = await runCheck(deps, new AbortController().signal);

    expect(message).toMatch(/Every link answered/);
    expect(message).toMatch(/Tailscale here: running on tailnet example-tailnet/);
    expect(message).toMatch(/Desktop in Tailscale: skipped/);
    expect(message).toMatch(/Model starter: .* answered — model_starter is on there/);
    // The port the desktop reports for model traffic is its own starter port,
    // read from the real `/models` body: without this field a laptop Connect
    // would write old direct-dial entries and say "update Forge on the desktop".
    expect(message).toMatch(
      new RegExp(`Model traffic for this laptop arrives on port ${desktop.starterPort}`),
    );
    expect(message).toMatch(new RegExp(`the earlier address did not answer|http://127\\.0\\.0\\.1:${dead}`));
    expect(message).toMatch(/Cloud relay: .* answered — cloud_relay is on there and allows 1 model/);
    expect(message).toMatch(/Models: all 2 models this laptop dials are servable/);
    // Nothing was started, loaded, pinned or released: the pool's own counters
    // are the proof, because a `POST /ensure` would move every one of them.
    expect(desktop.pool.prepareExternalCalls).toEqual([]);
    expect(desktop.pool.pinsTaken).toBe(0);
    expect(desktop.pool.unpins).toBe(0);
    expect(desktop.pool.releases).toEqual([]);
    // And the desktop's model servers were never touched at all: the pass-through
    // exists, but a read of `/models` has no reason to reach one.
    expect(desktop.slot.requests).toEqual([]);
    expect(desktop.external.requests).toEqual([]);
    expect(desktop.decoy.requests).toEqual([]);
    // The relay was asked for its allowlist and nothing else.
    expect(relay.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /v1/models',
    ]);
    // Nothing was changed on the tailnet: the only CLI call is the read.
    expect(tailscaleCalls).toEqual([['status', '--json']]);
  });

  it('the away route reports every link too, reading only /models and /v1/models', async () => {
    const asked: string[] = [];
    const starterUrl = 'http://100.64.0.10:8798';
    const relayUrl = 'http://100.64.0.10:8797';
    const deps: DesktopCheckDeps = {
      getConfig: () => laptopConfig(starterUrl, relayUrl, 8798),
      runTailscale: fakeTailscale(
        async () =>
          statusJson({
            peers: [
              { name: 'desktop.example-tailnet.ts.net.', ips: ['100.64.0.10'], online: true },
            ],
          }),
      ),
      fetchImpl: fakeFetch(
        {
          [`${starterUrl}/models`]: starterRows,
          [`${relayUrl}/v1/models`]: () => json({ object: 'list', data: [{ id: 'grok-code-fast' }] }),
        },
        asked,
      ),
    };
    const message = await runCheck(deps, new AbortController().signal);
    expect(message).toMatch(/Every link answered/);
    expect(message).toMatch(/Desktop in Tailscale: desktop \(100.64.0.10\) is online/);
    // The address dialled is the one the config lists, and only the two read-only
    // paths: a check that POSTed `/ensure` would show up here.
    expect(asked).toEqual([`${starterUrl}/models`, `${relayUrl}/v1/models`]);
  });

  it('Tailscale not running here is the first broken link, and nothing is dialled after it', async () => {
    const asked: string[] = [];
    const deps: DesktopCheckDeps = {
      getConfig: () =>
        laptopConfig('http://100.64.0.10:8798', 'http://100.64.0.10:8797', 8798),
      runTailscale: fakeTailscale(async () => {
        throw new Error('the Tailscale daemon did not answer');
      }),
      fetchImpl: fakeFetch({}, asked),
    };
    const message = await runCheck(deps, new AbortController().signal);
    expect(message).toMatch(/first link that is broken is: Tailscale here/);
    expect(message).toMatch(/Tailscale is not running on this computer/);
    expect(message).toMatch(/Start Tailscale on this laptop and sign in/);
    // The walk stopped: no probe, no read, no round trip into a dead network.
    expect(asked).toEqual([]);
  });

  it('a signed-out Tailscale is reported as broken, not as running', async () => {
    const asked: string[] = [];
    const deps: DesktopCheckDeps = {
      getConfig: () =>
        laptopConfig('http://100.64.0.10:8798', 'http://100.64.0.10:8797', 8798),
      runTailscale: fakeTailscale(async () => statusJson({ state: 'LoginRequired' })),
      fetchImpl: fakeFetch({}, asked),
    };
    const message = await runCheck(deps, new AbortController().signal);
    expect(message).toMatch(/first link that is broken is: Tailscale here/);
    expect(message).toMatch(/loginrequired, not connected/);
    expect(message).toMatch(/Sign in with Tailscale on this computer/);
    expect(asked).toEqual([]);
  });

  it('a laptop that also dials a LAN address is not told it is broken by one dead route', async () => {
    desktop = await startPassThroughStarter();
    relay = await startFakeModelServer();
    const config = withRefusals(
      laptopConfig(
        `http://127.0.0.1:${desktop.starterPort}`,
        `http://127.0.0.1:${relay.port}`,
        desktop.starterPort,
      ),
    );
    const deps: DesktopCheckDeps = {
      getConfig: () => config,
      // Tailscale down, and every address is loopback: the LAN route still
      // applies, so this is a note and the walk goes on to the links that matter.
      runTailscale: fakeTailscale(async () => {
        throw new Error('the Tailscale CLI was not found on this machine');
      }),
      fetchImpl: fetch,
      relayPort: relay.port,
    };
    const message = await runCheck(deps, new AbortController().signal);
    expect(message).toMatch(/Tailscale is not installed on this computer/);
    expect(message).toMatch(/Continuing anyway: this config also dials a LAN address/);
    expect(message).toMatch(/Model starter: http:\/\/127\.0\.0\.1:\d+ answered/);
    // Tailscale really is down, so it is the link the headline names — and the
    // models problem is not hidden behind it: the message says what else is broken.
    expect(message).toMatch(/first link that is broken is: Tailscale here/);
    expect(message).toMatch(/Further down the path these are broken too: Models/);
    expect(message).toMatch(/typo-iq3s: the desktop does not list it at all/);
    expect(message).toMatch(/llama3: the desktop refuses it \(it is an Ollama model/);
    expect(desktop.pool.pinsTaken).toBe(0);
  });

  it('a desktop that is offline in Tailscale is named, and the walk does not probe it', async () => {
    const asked: string[] = [];
    const deps: DesktopCheckDeps = {
      getConfig: () =>
        laptopConfig('http://100.64.0.10:8798', 'http://100.64.0.10:8797', 8798),
      runTailscale: fakeTailscale(
        async () =>
          statusJson({
            peers: [
              { name: 'laptop.example-tailnet.ts.net.', ips: ['100.64.0.21'], online: true },
              {
                name: 'desktop.example-tailnet.ts.net.',
                ips: ['100.64.0.10'],
                online: false,
              },
            ],
          }),
      ),
      fetchImpl: fakeFetch({}, asked),
    };
    const message = await runCheck(deps, new AbortController().signal);
    expect(message).toMatch(/first link that is broken is: Desktop in Tailscale/);
    expect(message).toMatch(/the desktop desktop is on this tailnet but is not online now/);
    expect(message).toMatch(/Wake the desktop or start Tailscale on it/);
    expect(asked).toEqual([]);
  });

  it('an address that is not on this tailnet at all is reported as its own problem', async () => {
    const asked: string[] = [];
    const deps: DesktopCheckDeps = {
      getConfig: () => laptopConfig('http://100.99.99.99:8798', 'http://100.99.99.99:8797', 8798),
      runTailscale: fakeTailscale(
        async () =>
          statusJson({ peers: [{ name: 'laptop', ips: ['100.64.0.21'], online: true }] }),
      ),
      fetchImpl: fakeFetch({}, asked),
    };
    const message = await runCheck(deps, new AbortController().signal);
    expect(message).toMatch(/first link that is broken is: Desktop in Tailscale/);
    expect(message).toMatch(/no machine with the address this laptop dials \(100\.99\.99\.99\)/);
    expect(message).toMatch(/same tailnet as this computer's\?/);
    expect(asked).toEqual([]);
  });

  it('no configured address answering names every address with its reason', async () => {
    const deadA = await freePort();
    const deadB = await freePort();
    const deps: DesktopCheckDeps = {
      getConfig: () =>
        withStarters(
          laptopConfig(`http://127.0.0.1:${deadA}`, `http://127.0.0.1:${deadB}`, deadA),
          [`http://127.0.0.1:${deadA}`, `http://127.0.0.1:${deadB}`],
        ),
      runTailscale: fakeTailscale(async () => statusJson({ peers: [] })),
      fetchImpl: fetch,
      relayPort: deadB,
    };
    const message = await runCheck(deps, new AbortController().signal);
    expect(message).toMatch(/first link that is broken is: Model starter/);
    expect(message).toMatch(/Desktop model starter not reachable at any configured address/);
    expect(message).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${deadA} \\(`));
    expect(message).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${deadB} \\(`));
    expect(message).toMatch(/is a Forge window open on the desktop with model_starter\.enabled: true\?/);
    expect(message).toMatch(/Open a Forge window on the desktop and run Forge: Share this computer/);
  });

  it('a silent relay is the first broken link for cloud models only, and the walk goes on', async () => {
    desktop = await startPassThroughStarter();
    const deadRelay = await freePort();
    const config = laptopConfig(
      `http://127.0.0.1:${desktop.starterPort}`,
      `http://127.0.0.1:${deadRelay}`,
      desktop.starterPort,
    );
    const deps: DesktopCheckDeps = {
      getConfig: () => config,
      runTailscale: fakeTailscale(async () => statusJson({ peers: [] })),
      fetchImpl: fetch,
      relayPort: deadRelay,
    };
    const message = await runCheck(deps, new AbortController().signal);
    expect(message).toMatch(/first link that is broken is: Cloud relay/);
    expect(message).toMatch(/nothing answered on any relay address this laptop could reach/);
    expect(message).toMatch(/cloud_relay\.enabled: true on the desktop/);
    // The link after it was still walked, because a laptop whose desktop models
    // work is not a broken laptop.
    expect(message).toMatch(/Models: all 2 models this laptop dials are servable/);
    expect(message).toMatch(/own models are not affected/);
    expect(desktop.pool.pinsTaken).toBe(0);
  });

  it('a laptop with no cloud entry does not go looking for a relay', async () => {
    desktop = await startPassThroughStarter();
    const config = laptopConfig(
      `http://127.0.0.1:${desktop.starterPort}`,
      'http://127.0.0.1:1',
      desktop.starterPort,
    );
    const deps: DesktopCheckDeps = {
      getConfig: () => ({
        ...config,
        models: config.models.filter((model) => model.name !== 'grok-code-fast'),
      }),
      runTailscale: fakeTailscale(async () => statusJson({ peers: [] })),
      fetchImpl: fetch,
      relayPort: 1,
    };
    const message = await runCheck(deps, new AbortController().signal);
    expect(message).toMatch(/Cloud relay: skipped: this laptop lists no cloud models/);
    expect(message).toMatch(/Every link answered/);
    expect(desktop.pool.pinsTaken).toBe(0);
  });

  it('a laptop that has never connected is told to connect, not probed', async () => {
    const asked: string[] = [];
    const deps: DesktopCheckDeps = {
      getConfig: () =>
        ({
          models: [{ name: 'gemma-iq3s', provider: 'llama.cpp', gguf_path: '/gemma.gguf' }],
          active_model: 'gemma-iq3s',
          llama_server: {},
        }) as unknown as ForgeConfig,
      runTailscale: fakeTailscale(async () => statusJson()),
      fetchImpl: fakeFetch({}, asked),
    };
    const message = await runCheck(deps, new AbortController().signal);
    expect(message).toMatch(/first link that is broken is: Config/);
    expect(message).toMatch(/lists no models that come from another computer/);
    expect(message).toMatch(/Run Forge: Connect to my desktop first/);
    // Not even Tailscale was asked: there is no desktop to find yet.
    expect(asked).toEqual([]);
    expect(tailscaleCalls).toEqual([]);
  });

  /** Seam question 1 for phase 3.4 — what cancels the waits, and is that path
   *  tested. Every read here is bounded by its own deadline (the probe's 2.5 s,
   *  the two reads' 10 s and 5 s, the CLI read's 4 s), so the mechanism left to
   *  pin here is the abort `registerDesktopCheckConnectionCommands` pushes into
   *  `context.subscriptions`: it has to be cancelled work, not decoration.
   *
   *  Seam question 2 — what checks the data acted on came from the right sender:
   *  none, and for a stated reason. Everything this command acts on is its own
   *  request's response (its config, `tailscale status --json`, `GET /models`,
   *  `GET /v1/models`) or its own config's addresses; there is no session, chat
   *  or inbound message to attribute anything to, so there is no sender to check.
   */
  it('closing the window cancels a check in flight instead of leaving it running', async () => {
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    let inFlight = 0;
    registerDesktopCheckConnectionCommands(context as never, {
      getConfig: () =>
        laptopConfig('http://100.64.0.10:8798', 'http://100.64.0.10:8797', 8798),
      runTailscale: (args: string[], signal?: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          inFlight += 1;
          const fail = (): void => {
            clearTimeout(timer);
            inFlight -= 1;
            reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
          };
          const timer = setTimeout(() => {
            inFlight -= 1;
            resolve(statusJson());
          }, 10_000);
          timer.unref?.();
          if (signal?.aborted) fail();
          else signal?.addEventListener('abort', fail);
        }),
      fetchImpl: fakeFetch({}, []),
    });
    const running = ui.handlers[DESKTOP_CHECK_COMMAND]!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    context.subscriptions.forEach((disposable) => disposable.dispose());
    const first = await running;
    // A cancelled check must not come back as a diagnosis: "Tailscale is not
    // running here" would send the owner to fix a daemon that was never broken,
    // so the message says the window closed and nothing else.
    expect(String(first)).toMatch(/was cancelled: this window closed/);
    expect(String(first)).not.toMatch(/Tailscale is not running/);
    // Nothing is still waiting on a machine this window no longer has.
    expect(inFlight).toBe(0);
    // And the same command afterwards does not start a fresh round trip: the
    // signal is already aborted, so the check reports itself cancelled at once.
    const second = await ui.handlers[DESKTOP_CHECK_COMMAND]!();
    expect(String(second)).toMatch(/was cancelled: this window closed/);
    expect(inFlight).toBe(0);
  });

  /** The same disposable, landing on the link the check shares with
   *  `Forge: Connect to my desktop` instead of on the Tailscale read. The shared
   *  walker is where a cancellation rule can quietly become decoration: a read
   *  the window closed on has to propagate, because recorded as "the relay
   *  refused" it sends the owner to flip `cloud_relay.enabled` on a desktop that
   *  was never given the chance to answer. `getWithDeadline` already rethrows a
   *  caller cancellation; what this pins is the walker not swallowing it and
   *  dialling the next address as if the window were still open.
   *
   *  One relay address is tried here, not zero and not two: `relayCandidates`
   *  gives this config exactly one, and the count is what shows the walk stopped
   *  at the cancellation rather than running on to the fifth link. */
  it('cancelled during the shared relay read: cancelled, not a dead relay', async () => {
    const asked: string[] = [];
    let inFlight = 0;
    const context = { subscriptions: [] as Array<{ dispose(): void }> };
    registerDesktopCheckConnectionCommands(context as never, {
      getConfig: () => laptopConfig('http://100.64.0.10:8798', 'http://100.64.0.10:8797', 8798),
      runTailscale: fakeTailscale(
        async () =>
          statusJson({
            peers: [
              { name: 'desktop.example-tailnet.ts.net.', ips: ['100.64.0.10'], online: true },
            ],
          }),
      ),
      // The starter answers at once, so the walk reaches the relay; the relay
      // holds the connection open until somebody aborts it, which is what a real
      // request does when the window closes before its answer.
      fetchImpl: ((async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        asked.push(url);
        if (!url.endsWith('/v1/models')) return starterRows();
        inFlight += 1;
        return await new Promise<Response>((resolve, reject) => {
          const fail = (): void => {
            inFlight -= 1;
            reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
          };
          if (init?.signal?.aborted) fail();
          else init?.signal?.addEventListener('abort', fail);
        });
      }) as unknown as typeof fetch),
    });
    const running = ui.handlers[DESKTOP_CHECK_COMMAND]!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The cancellation has to land while the relay read is in flight, or this
    // test would only prove the previous one's point again.
    expect(asked.filter((url) => url.endsWith('/v1/models')).length).toBe(1);
    context.subscriptions.forEach((disposable) => disposable.dispose());
    const message = await running;
    expect(String(message)).toMatch(/was cancelled: this window closed/);
    // Not "nothing answered on any relay address": a cancelled read is not a
    // diagnosis of the desktop, and the walk must not report a verdict built on
    // a link nobody was allowed to finish asking about.
    expect(String(message)).not.toMatch(/nothing answered on any relay address/);
    expect(inFlight).toBe(0);
  });
});
