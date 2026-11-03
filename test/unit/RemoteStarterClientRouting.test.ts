/**
 * The autoswitch half of the laptop starter client (docs/plans/
 * LAPTOP_LAN_ACCESS_PLAN.md Phase 1): which of the `remote_start.starter`
 * addresses a `remote_start` request goes to, and what happens to the cached
 * leases when that address stops being the route.
 *
 * These tests use an injected `fetch`, clock and fingerprint rather than a real
 * loopback listener, because what has to be observed is the ADDRESS: the base
 * URL is rebuilt on the host that answered, and two loopback listeners differ
 * only by port, so a loopback harness could not tell the two routes apart. The
 * wire itself — that the port in the answer replaces the one in the config, and
 * that each failure class produces the message that names the fix — is proven by
 * `RemoteStarterClient.test.ts` against real listeners, and that file still
 * passes unchanged.
 *
 * The addresses are documentation ones (192.0.2.0/24 for the LAN, 100.64.0.0/10
 * for the tailnet) and nothing connects to them: the fake answers in memory, so
 * no real machine on any network can be mistaken for the desktop.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { RemoteStarterClient } from '../../src/llm/RemoteStarterClient';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';

const HOME = 'http://192.0.2.10:8798';
const AWAY = 'http://100.64.0.10:8798';
const HOME_HOST = 'http://192.0.2.10';
const AWAY_HOST = 'http://100.64.0.10';

/** One desktop's behaviour, per address: whether `GET /models` says it is a Forge
 *  starter, and what `POST /ensure` does. `'dead'` is the shape `tailscale
 *  serve` produces for a stopped listener — a reset, not a refusal — and the LAN
 *  forwarder going off is the same thing on the other path. */
interface Desk {
  models: boolean;
  ensure: number | 'dead' | { status: number; body?: Record<string, unknown> };
}

/** A laptop's entry for a desktop model. `endpoint` deliberately names the AWAY
 *  host in most of these tests: the base URL has to be rebuilt on whichever
 *  address answered, so the host in the config cannot be what it comes out with.
 */
function laptopEntry(starter: string | string[], endpoint = AWAY_HOST): ModelConfig {
  return {
    name: 'strata-laptop',
    provider: 'openai-compatible',
    endpoint: `${endpoint}:8090`,
    model: 'qwen',
    remote_start: { starter, model: 'strata-iq3s' },
  } as unknown as ModelConfig;
}

/** A `fetch` that answers per address, in memory, and records the calls. `onCall`
 *  lets a test make an address change half way through a scenario — the desktop
 *  going to sleep between the probe and the `/ensure` is exactly that. */
function fakeLaptops(
  desks: Record<string, Desk>,
  clock: { t: number },
  leaseTtlMs = 600_000,
  onCall?: (call: { method: string; base: string; pathname: string }) => void,
) {
  const calls: string[] = [];
  const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const json = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url));
    const base = target.origin;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${base}${target.pathname}`);
    onCall?.({ method, base, pathname: target.pathname });
    const desk = desks[base];
    if (!desk) throw refused();
    if (method === 'GET') {
      if (!desk.models) throw refused();
      return json(200, { models: [{ name: 'strata-iq3s' }] });
    }
    if (target.pathname === '/release') return json(200, { released: ['strata-iq3s'] });
    if (target.pathname === '/unload') return json(200, { unloaded: true });
    if (typeof desk.ensure === 'number') {
      return json(200, {
        model: 'strata-iq3s',
        port: desk.ensure,
        leaseId: `lease-${desk.ensure}`,
        expiresAt: clock.t + leaseTtlMs,
      });
    }
    if (desk.ensure === 'dead') throw reset();
    return json(desk.ensure.status, desk.ensure.body ?? {});
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** A laptop window: the client, the calls it made, and the clock and network it
 *  is on — all three injected, so a test can turn the clock, move the laptop, or
 *  kill a desktop without waiting for any of them to happen. */
function windowOn(
  entry: ModelConfig,
  desks: Record<string, Desk>,
  options: {
    fingerprint?: () => string;
    isTurnActive?: () => boolean;
    leaseTtlMs?: number;
    onCall?: (call: { method: string; base: string; pathname: string }) => void;
  } = {},
) {
  const clock = { t: 1_700_000_000_000 };
  const { calls, fetchImpl } = fakeLaptops(desks, clock, options.leaseTtlMs, options.onCall);
  const client = new RemoteStarterClient(
    () => ({ models: [entry], active_model: entry.name, llama_server: {} }) as ForgeConfig,
    () => options.isTurnActive?.() ?? false,
    () => clock.t,
    fetchImpl,
    options.fingerprint ?? (() => 'home'),
  );
  return { client, calls, clock };
}

const modelOf = (entry: ModelConfig) => entry;

describe('RemoteStarterClient autoswitch', () => {
  afterEach(() => {
    // Nothing here leaves a timer running: renew timers are unref'd and every
    // test either releases or drops its leases.
  });

  it('builds the base URL on the host that answered, not the one in the config', async () => {
    const entry = laptopEntry([HOME, AWAY]); // endpoint names AWAY on purpose
    const desks: Record<string, Desk> = {
      [HOME]: { models: true, ensure: 8082 },
      [AWAY]: { models: true, ensure: 8090 },
    };
    const { client, calls } = windowOn(entry, desks);
    const { baseUrl } = await client.ensure(modelOf(entry));
    // Home first in config order, and it answers: the laptop is at home, so the
    // away host in `endpoint` is not what the chat request goes to.
    expect(baseUrl).toBe('http://192.0.2.10:8082');
    expect(calls).toEqual([`GET ${HOME}/models`, `POST ${HOME}/ensure`]);
  });

  it('dials the last address unprobed when the first one is not a starter', async () => {
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: { models: false, ensure: 'dead' },
      [AWAY]: { models: true, ensure: 8090 },
    };
    const { client, calls } = windowOn(entry, desks);
    const { baseUrl } = await client.ensure(modelOf(entry));
    expect(baseUrl).toBe('http://100.64.0.10:8090');
    // AWAY was never probed: its `/ensure` is the probe, and it reported the
    // port, so away mode pays one round trip rather than two.
    expect(calls).toEqual([`GET ${HOME}/models`, `POST ${AWAY}/ensure`]);
  });

  it('reuses a cached lease with no request at all while the route is fresh', async () => {
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: { models: true, ensure: 8082 },
      [AWAY]: { models: true, ensure: 8090 },
    };
    const { client, calls, clock } = windowOn(entry, desks);
    const first = await client.ensure(modelOf(entry));
    clock.t += 30_000; // well inside rule (d)'s minute
    const second = await client.ensure(modelOf(entry));
    expect(second.baseUrl).toBe(first.baseUrl);
    expect(calls).toEqual([`GET ${HOME}/models`, `POST ${HOME}/ensure`]);
  });

  it('drops every cached lease and re-probes when the laptop changes networks', async () => {
    // The CI-enforced row of the plan's state ledger: a new caller of `ensure()`
    // that skipped the fingerprint check would keep sending a laptop that left
    // home to 192.0.2.10 until its lease expired — up to ten minutes of
    // requests to a machine that is not there.
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: { models: true, ensure: 8082 },
      [AWAY]: { models: true, ensure: 8090 },
    };
    let home = true;
    const { client, calls, clock } = windowOn(entry, desks, {
      fingerprint: () => (home ? 'home' : 'cafe'),
    });
    const atHome = await client.ensure(modelOf(entry));
    clock.t += 5_000; // inside the freshness window: only the move can force this
    // The laptop left home: the LAN address it remembered is now somebody
    // else's machine, or nothing at all.
    home = false;
    desks[HOME] = { models: false, ensure: 'dead' };
    const away = await client.ensure(modelOf(entry));
    // The lease was dropped, not reused: the request went out again, and this
    // time through the address the new network can actually reach.
    expect(away.baseUrl).toBe('http://100.64.0.10:8090');
    expect(away.baseUrl).not.toBe(atHome.baseUrl);
    expect(calls).toEqual([
      `GET ${HOME}/models`,
      `POST ${HOME}/ensure`,
      `GET ${HOME}/models`,
      `POST ${AWAY}/ensure`,
    ]);
  });

  it('retries an unreachable /ensure exactly once, through the re-chosen address', async () => {
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: { models: true, ensure: 'dead' },
      [AWAY]: { models: true, ensure: 8090 },
    };
    const { client, calls } = windowOn(entry, desks, {
      // HOME answers the probe and then stops answering anything: the desktop
      // went to sleep with the laptop half way through its request.
      onCall: ({ method, base }) => {
        if (method === 'POST' && base === HOME) desks[HOME] = { models: false, ensure: 'dead' };
      },
    });
    const first = await client.ensure(modelOf(entry));
    expect(first.baseUrl).toBe('http://100.64.0.10:8090');
    expect(calls).toEqual([
      `GET ${HOME}/models`,
      `POST ${HOME}/ensure`,
      `GET ${HOME}/models`,
      `POST ${AWAY}/ensure`,
    ]);
    // Exactly one retry: a second failure would be reported, not walked through
    // every address in the list.
    expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(2);
  });

  it('re-verifies a stale route before reusing a cached lease, and re-chooses if it fails', async () => {
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: { models: true, ensure: 8082 },
      [AWAY]: { models: true, ensure: 8090 },
    };
    const { client, calls, clock } = windowOn(entry, desks);
    await client.ensure(modelOf(entry));
    clock.t += 61_000; // past rule (d)'s minute, still inside the lease
    // The café that hands out the same addresses: the fingerprint is unchanged,
    // so only the probe can notice that 192.0.2.10 is no longer the desktop.
    desks[HOME] = { models: false, ensure: 'dead' };
    const { baseUrl } = await client.ensure(modelOf(entry));
    expect(baseUrl).toBe('http://100.64.0.10:8090');
    expect(calls).toEqual([
      `GET ${HOME}/models`,
      `POST ${HOME}/ensure`,
      `GET ${HOME}/models`, // the re-verify, which fails
      `GET ${HOME}/models`, // the re-choose, from the first address again
      `POST ${AWAY}/ensure`,
    ]);
  });

  it('keeps a cached lease when the re-verify answers', async () => {
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: { models: true, ensure: 8082 },
      [AWAY]: { models: true, ensure: 8090 },
    };
    const { client, calls, clock } = windowOn(entry, desks);
    const first = await client.ensure(modelOf(entry));
    clock.t += 61_000;
    const second = await client.ensure(modelOf(entry));
    expect(second.baseUrl).toBe(first.baseUrl);
    // One probe, no second `/ensure`: the route answered, so the lease stands.
    expect(calls).toEqual([`GET ${HOME}/models`, `POST ${HOME}/ensure`, `GET ${HOME}/models`]);
  });

  it('does not switch on an HTTP status, and names the desktop busy model', async () => {
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: {
        models: true,
        ensure: {
          status: 409,
          body: { error: 'Cannot load beside strata-iq3s', busyModel: ['strata-iq3s'] },
        },
      },
      [AWAY]: { models: true, ensure: 8090 },
    };
    const { client, calls } = windowOn(entry, desks);
    await expect(client.ensure(modelOf(entry))).rejects.toThrow(
      /Desktop is busy running strata-iq3s/,
    );
    // A refusal is an answer: dialing the same desktop through Tailscale would
    // get the same 409 back, so nothing was retried and nothing was switched.
    expect(calls).toEqual([`GET ${HOME}/models`, `POST ${HOME}/ensure`]);
  });

  it('reports every address when the retry fails too', async () => {
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: { models: true, ensure: 'dead' },
      [AWAY]: { models: true, ensure: 'dead' },
    };
    const { client } = windowOn(entry, desks, {
      // HOME answers the probe, fails the `/ensure`, and then stops answering
      // the probe too, so the re-choose has somewhere else to go and both
      // addresses end up named with their own reason.
      onCall: ({ method, base }) => {
        if (method === 'POST' && base === HOME) desks[HOME] = { models: false, ensure: 'dead' };
      },
    });
    await expect(client.ensure(modelOf(entry))).rejects.toThrow(
      // Each address is named with the reason this window last saw for it: HOME
      // reset the `/ensure` and then refused the re-choose, and AWAY reset its
      // own retry.
      /not reachable at any configured address: http:\/\/192.0.2.10:8798 \(ECONNREFUSED\); http:\/\/100.64.0.10:8798 \(ECONNRESET\)/,
    );
  });

  it('sends /unload back to the starter that earned the lease', async () => {
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: { models: true, ensure: 8082 },
      [AWAY]: { models: true, ensure: 8090 },
    };
    const { client, calls } = windowOn(entry, desks);
    await client.ensure(modelOf(entry)); // lease earned through HOME
    // The LAN route goes away between two models: the second `/ensure` re-chooses
    // to AWAY, and rule (c) deliberately does NOT drop the leases, so the two
    // starters now hold leases between them.
    desks[HOME] = { models: false, ensure: 'dead' };
    const modelB = { ...entry, name: 'maya-laptop' } as unknown as ModelConfig;
    await client.ensure(modelB); // through AWAY, the new winner
    expect(await client.unload(modelOf(entry))).toEqual({ unloaded: true });
    // The desktop that holds A's lease is the one that has to be told to free
    // it: the new winner has never heard of that lease, and dialing it would
    // free nothing.
    expect(calls.filter((call) => call.endsWith('/unload'))).toEqual([`POST ${HOME}/unload`]);
  });

  it('releases once per distinct starter that holds a lease', async () => {
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: { models: true, ensure: 8082 },
      [AWAY]: { models: true, ensure: 8090 },
    };
    const { client, calls } = windowOn(entry, desks);
    await client.ensure(modelOf(entry)); // through HOME
    desks[HOME] = { models: false, ensure: 'dead' };
    const modelB = { ...entry, name: 'maya-laptop' } as unknown as ModelConfig;
    await client.ensure(modelB); // through AWAY, HOME's lease still held
    const before = calls.length;
    await client.release();
    // One POST each: `firstStarterUrl()` would have told only one desktop, and
    // the other would have kept holding its model until the lease expired.
    expect(calls.slice(before).filter((call) => call.endsWith('/release'))).toEqual([
      `POST ${HOME}/release`,
      `POST ${AWAY}/release`,
    ]);
  });

  it('renews through the starter that earned the lease', async () => {
    const entry = laptopEntry([HOME, AWAY]);
    const desks: Record<string, Desk> = {
      [HOME]: { models: true, ensure: 8082 },
      [AWAY]: { models: true, ensure: 8090 },
    };
    const { client, calls } = windowOn(entry, desks, {
      isTurnActive: () => true,
      leaseTtlMs: 3_000, // renews a third of its life later, so this waits 1 s
    });
    await client.ensure(modelOf(entry)); // lease earned through HOME
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    // The heartbeat went to HOME, the address the lease was earned through, and
    // it made no new choice: a live route is not re-probed on every beat.
    expect(calls.filter((call) => call.endsWith('/ensure'))).toEqual([
      `POST ${HOME}/ensure`,
      `POST ${HOME}/ensure`,
    ]);
    expect(calls.filter((call) => call.startsWith('GET'))).toEqual([`GET ${HOME}/models`]);
    expect(calls.some((call) => call.includes(AWAY))).toBe(false);
  });

  it('makes no probe at all for a one-address config', async () => {
    // The behaviour that shipped in 0.17.84, pinned end to end: no `GET
    // /models`, and a cached lease reused after a minute exactly as it was
    // before any list existed.
    const entry = laptopEntry([HOME]);
    const desks: Record<string, Desk> = { [HOME]: { models: true, ensure: 8082 } };
    const { client, calls, clock } = windowOn(entry, desks);
    const first = await client.ensure(modelOf(entry));
    expect(first.baseUrl).toBe('http://192.0.2.10:8082');
    clock.t += 61_000;
    const second = await client.ensure(modelOf(entry));
    expect(second.baseUrl).toBe(first.baseUrl);
    expect(calls).toEqual([`POST ${HOME}/ensure`]);
  });
});
