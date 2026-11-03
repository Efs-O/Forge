/**
 * Which of the `remote_start.starter` addresses a laptop dials, and when it has
 * to start choosing again (docs/plans/LAPTOP_LAN_ACCESS_PLAN.md Phase 1,
 * "Autoswitch").
 *
 * Every test here runs against an injected `fetch`, clock and set of network
 * interfaces, and none of them opens a real connection: the addresses are
 * documentation ones (192.0.2.0/24 for the LAN, 100.64.0.0/10 for the tailnet,
 * the range Tailscale hands out), so no real machine can be mistaken for the
 * desktop. They are still IP literals, because a test that wrote
 * `a.test`/`b.test` would not prove that the IP-literal shapes the schema
 * accepts reach this code unchanged.
 */
import * as os from 'os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  allStarterFailedMessage,
  chooseStarter,
  networkFingerprint,
  StarterRouter,
} from '../../src/llm/RemoteStarterRoute';
import { StarterUnreachableError } from '../../src/llm/RemoteStarterHttp';

const HOME = 'http://192.0.2.10:8798';
const NEIGHBOUR = 'http://192.0.2.11:8798';
const AWAY = 'http://100.64.0.10:8798';

/** How one address answers `GET /models`: like a Forge starter, like a server
 *  that is not one, like a machine that is not there, or like a black hole. */
type Answer = { models: unknown[] } | { status: number } | { code: string } | { hang: true };

/** A `fetch` that answers per address and records what it was asked for. It
 *  honours an aborted signal the way real `fetch` does — rejecting before any
 *  byte is sent — so a test can tell a user's Stop from an address that failed.
 *  The answers map is read at call time, so a test can make an address die
 *  half way through a scenario. */
function fakeFetch(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    calls.push(target);
    if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    const answer = answers[target.slice(0, -'/models'.length)] ?? { code: 'ECONNREFUSED' };
    if ('hang' in answer) {
      // A black hole answers nothing until the probe's own 2.5 s clock aborts
      // it, which is exactly what that clock is for.
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        ),
      );
    }
    if ('code' in answer) {
      throw Object.assign(new Error(`connect ${answer.code}`), { code: answer.code });
    }
    const body = 'models' in answer ? { models: answer.models } : { error: 'not a starter' };
    return {
      ok: !('status' in answer) || (answer.status >= 200 && answer.status < 300),
      status: 'status' in answer ? answer.status : 200,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** One entry of `os.networkInterfaces()`: the fields this code reads are the
 *  address, the family and whether it is internal; the rest are what the type
 *  demands. */
function iface(
  address: string,
  family: 'IPv4' | 'IPv6',
  internal: boolean,
): os.NetworkInterfaceInfo {
  return {
    address,
    family,
    internal,
    netmask: '255.255.255.0',
    mac: 'aa:bb:cc:dd:ee:ff',
    cidr: null,
    scopeid: 0,
  };
}

const AT_HOME = (): NodeJS.Dict<os.NetworkInterfaceInfo[]> => ({
  'Wi-Fi': [iface('192.0.2.20', 'IPv4', false), iface('fe80::1', 'IPv6', false)],
  Loopback: [iface('127.0.0.1', 'IPv4', true)],
  Tailscale: [iface('100.64.0.10', 'IPv4', false), iface('127.0.0.2', 'IPv4', true)],
});

/** The café that hands out the same addresses the home router does: the
 *  fingerprint cannot tell the two apart, which is why the client also re-verifies
 *  the route by probe (rule d). */
const SAME_ADDRESSES_ELSEWHERE = (): NodeJS.Dict<os.NetworkInterfaceInfo[]> => ({
  'Wi-Fi': [iface('192.0.2.20', 'IPv4', false)],
  Tailscale: [iface('100.64.0.10', 'IPv4', false)],
});

describe('chooseStarter', () => {
  it('uses the first address when it answers with a models list', async () => {
    const { calls, fetchImpl } = fakeFetch({
      [HOME]: { models: [{ name: 'strata-iq3s' }] },
      [AWAY]: { models: [] },
    });
    const choice = await chooseStarter([HOME, AWAY], fetchImpl);
    expect(choice.starter).toBe(HOME);
    expect(choice.failures).toEqual([]);
    // The winner answered, and the address after it was never touched: the last
    // address is the away one, and the `/ensure` sent to it reports its own
    // failure, so away mode pays one round trip rather than two.
    expect(calls).toEqual([`${HOME}/models`]);
  });

  it('gives up on a black hole after 2.5 s and uses the next address', async () => {
    vi.useFakeTimers();
    try {
      const { calls, fetchImpl } = fakeFetch({
        [HOME]: { hang: true },
        [NEIGHBOUR]: { models: [] },
        [AWAY]: { models: [] },
      });
      const pending = chooseStarter([HOME, NEIGHBOUR, AWAY], fetchImpl);
      await vi.advanceTimersByTimeAsync(2_500);
      const choice = await pending;
      expect(choice.starter).toBe(NEIGHBOUR);
      expect(choice.failures).toEqual([{ url: HOME, reason: 'timed out after 2.5 s' }]);
      expect(calls).toEqual([`${HOME}/models`, `${NEIGHBOUR}/models`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an address that answers 200 with something else win', async () => {
    // A device that has taken the desktop's LAN address on someone else's
    // network answers HTTP, and may even answer 200 — what makes a starter a
    // starter is the `models` list, not the status code.
    const { calls, fetchImpl } = fakeFetch({
      [HOME]: { status: 200 },
      [NEIGHBOUR]: { models: [] },
      [AWAY]: { models: [] },
    });
    const choice = await chooseStarter([HOME, NEIGHBOUR, AWAY], fetchImpl);
    expect(choice.starter).toBe(NEIGHBOUR);
    expect(choice.failures).toEqual([{ url: HOME, reason: 'HTTP 200 without a "models" list' }]);
    expect(calls).toEqual([`${HOME}/models`, `${NEIGHBOUR}/models`]);
  });

  it('reports any other status as that status', async () => {
    const { fetchImpl } = fakeFetch({
      [HOME]: { status: 503 },
      [NEIGHBOUR]: { models: [] },
      [AWAY]: { models: [] },
    });
    const choice = await chooseStarter([HOME, NEIGHBOUR, AWAY], fetchImpl);
    expect(choice.failures).toEqual([{ url: HOME, reason: 'HTTP 503' }]);
  });

  it('never probes the last address, even when every probed one failed', async () => {
    const { calls, fetchImpl } = fakeFetch({
      [HOME]: { code: 'ECONNRESET' },
      [NEIGHBOUR]: { status: 200 },
      [AWAY]: { models: [] },
    });
    const choice = await chooseStarter([HOME, NEIGHBOUR, AWAY], fetchImpl);
    // AWAY is last, so it is handed back unprobed: its `/ensure` will say what
    // is wrong with it, in the desktop's own words.
    expect(choice.starter).toBe(AWAY);
    expect(calls).toEqual([`${HOME}/models`, `${NEIGHBOUR}/models`]);
    expect(choice.failures.map((failure) => failure.url)).toEqual([HOME, NEIGHBOUR]);
  });

  it('makes no probe at all for a one-address config', async () => {
    // The behaviour that shipped in 0.17.84, pinned: a laptop with one address
    // has nowhere to choose between, so it must not grow a probe.
    const { calls, fetchImpl } = fakeFetch({});
    const choice = await chooseStarter([HOME], fetchImpl);
    expect(choice.starter).toBe(HOME);
    expect(calls).toEqual([]);
  });

  it('does not read a user Stop as the address failing', async () => {
    const { calls, fetchImpl } = fakeFetch({ [HOME]: { hang: true } });
    const ctrl = new AbortController();
    ctrl.abort();
    // A cancelled probe is not HOME's failure: recording it as one would let the
    // next address be chosen and then overwritten by this window's cancellation.
    await expect(chooseStarter([HOME, NEIGHBOUR, AWAY], fetchImpl, ctrl.signal)).rejects.toThrow(
      /aborted/i,
    );
    expect(calls).toEqual([`${HOME}/models`]);
  });
});

describe('allStarterFailedMessage', () => {
  it('names every address with its reason, and the three things it could be', () => {
    const message = allStarterFailedMessage([
      { url: HOME, reason: 'timed out after 2.5 s' },
      { url: AWAY, reason: 'ECONNRESET' },
    ]);
    expect(message).toMatch(
      /not reachable at any configured address: http:\/\/192.0.2.10:8798 \(timed out after 2\.5 s\); http:\/\/100.64.0.10:8798 \(ECONNRESET\)/,
    );
    expect(message).toMatch(/At home: .*LAN forwarder on\?/);
    expect(message).toMatch(/Away: is Tailscale up\?/);
    expect(message).toMatch(/model_starter\.enabled: true\?/);
  });
});

describe('networkFingerprint', () => {
  it('is the sorted non-internal IPv4 addresses, and nothing else', () => {
    // The loopback and the IPv6 link-local address are left out: they are the
    // same on every machine, so including them would make two different
    // networks look like one change the laptop never made.
    expect(networkFingerprint(AT_HOME)).toBe('100.64.0.10,192.0.2.20');
  });

  it('changes when the laptop moves to addresses it had not had', () => {
    const cafe = (): NodeJS.Dict<os.NetworkInterfaceInfo[]> => ({
      'Wi-Fi': [iface('192.168.50.12', 'IPv4', false)],
    });
    expect(networkFingerprint(cafe)).not.toBe(networkFingerprint(AT_HOME));
  });

  it('cannot tell apart two networks that hand out the same addresses', () => {
    // Not a defect to fix, a limit to design around: this is why the client
    // re-verifies the route by probe before reusing a cached lease (rule d).
    expect(networkFingerprint(SAME_ADDRESSES_ELSEWHERE)).toBe(networkFingerprint(AT_HOME));
  });
});

describe('StarterRouter', () => {
  /** A clock the test turns, so rule (d)'s minute does not have to pass. */
  const clockOf = (start = 1_000_000): { now: () => number; advance: (ms: number) => void } => {
    let value = start;
    return { now: () => value, advance: (ms: number) => (value += ms) };
  };
  /** The router compares fingerprints as strings, so a test hands it a string.
   *  Passing the interfaces map itself would make every call look like a network
   *  change, because two calls of the same function return two different
   *  objects. */
  const atHome = (): string => networkFingerprint(AT_HOME);

  it('chooses once and reuses the winner without probing again', async () => {
    const { calls, fetchImpl } = fakeFetch({ [HOME]: { models: [] }, [AWAY]: { models: [] } });
    const router = new StarterRouter(() => 1_000, fetchImpl, atHome);
    for (let attempt = 0; attempt < 3; attempt++) {
      const route = await router.routeFor({ urls: [HOME, AWAY] });
      expect(route.starter).toBe(HOME);
      expect(route.leasesMustDrop).toBe(false);
    }
    expect(calls).toEqual([`${HOME}/models`]); // three decisions, one probe
  });

  it('drops the memory and reports the leases when the network changes', async () => {
    const answers: Record<string, Answer> = { [HOME]: { models: [] }, [AWAY]: { models: [] } };
    const { calls, fetchImpl } = fakeFetch(answers);
    let home = true;
    const fingerprint = () => (home ? atHome() : '192.168.50.12');
    const router = new StarterRouter(() => 1_000, fetchImpl, fingerprint);
    await router.routeFor({ urls: [HOME, AWAY] });
    // The laptop left home: the LAN address it remembered is now somebody
    // else's machine, or nothing at all.
    home = false;
    answers[HOME] = { code: 'EHOSTUNREACH' };
    const route = await router.routeFor({ urls: [HOME, AWAY] });
    expect(route.leasesMustDrop).toBe(true);
    expect(route.starter).toBe(AWAY);
    // The second probe of HOME is the re-choose working from the first address
    // again: config order is probe order every time (decision D4).
    expect(calls).toEqual([`${HOME}/models`, `${HOME}/models`]);
    expect(route.failures).toEqual([{ url: HOME, reason: 'EHOSTUNREACH' }]);
  });

  it('keeps the route while it answers, and reports it stale after a minute', async () => {
    const { now, advance } = clockOf();
    const { calls, fetchImpl } = fakeFetch({ [HOME]: { models: [] }, [AWAY]: { models: [] } });
    const router = new StarterRouter(now, fetchImpl, atHome);
    await router.routeFor({ urls: [HOME, AWAY] });
    expect(router.contactIsFresh()).toBe(true);
    advance(30_000);
    expect(router.contactIsFresh()).toBe(true); // at home this costs nothing, and rarely fires
    advance(31_000);
    expect(router.contactIsFresh()).toBe(false); // 61 s since the last answer
    const reverified = await router.reverifyRoute({ urls: [HOME, AWAY] });
    expect(reverified.starter).toBe(HOME);
    expect(reverified.leasesMustDrop).toBe(false);
    expect(router.contactIsFresh()).toBe(true);
    expect(calls).toEqual([`${HOME}/models`, `${HOME}/models`]); // probe, then re-verify
  });

  it('re-chooses and says the leases have to go when the re-verify fails', async () => {
    const { now, advance } = clockOf();
    const answers: Record<string, Answer> = {
      [HOME]: { models: [] },
      [NEIGHBOUR]: { models: [] },
      [AWAY]: { models: [] },
    };
    const { calls, fetchImpl } = fakeFetch(answers);
    const router = new StarterRouter(now, fetchImpl, atHome);
    await router.routeFor({ urls: [HOME, NEIGHBOUR, AWAY] });
    // The café that hands out the same addresses the home router does: the
    // fingerprint is unchanged, so only the probe can notice that
    // 192.0.2.10 is no longer the desktop.
    answers[HOME] = { code: 'ECONNREFUSED' };
    advance(61_000);
    const route = await router.reverifyRoute({ urls: [HOME, NEIGHBOUR, AWAY] });
    expect(route.starter).toBe(NEIGHBOUR);
    expect(route.leasesMustDrop).toBe(true);
    expect(route.failures).toEqual([{ url: HOME, reason: 'ECONNREFUSED' }]);
    // One probe to re-verify, then the re-choose starting from the first address
    // again — HOME is dialed twice because that is what the plan's rule (d)
    // says, and a minute of saved probes is worth one duplicate.
    expect(calls).toEqual([
      `${HOME}/models`,
      `${HOME}/models`,
      `${HOME}/models`,
      `${NEIGHBOUR}/models`,
    ]);
  });

  it('retries an unreachable call once through the re-chosen address', async () => {
    const answers: Record<string, Answer> = { [HOME]: { models: [] }, [AWAY]: { models: [] } };
    const { calls, fetchImpl } = fakeFetch(answers);
    const router = new StarterRouter(() => 1_000, fetchImpl, atHome);
    const dials: string[] = [];
    const answer = await router.call({
      urls: [HOME, AWAY],
      dial: async (starter) => {
        dials.push(starter);
        if (dials.length === 1) {
          // The desktop answered `/models` and then its socket reset: by the
          // time the router chooses again, HOME is not answering at all.
          answers[HOME] = { code: 'ECONNRESET' };
          throw new StarterUnreachableError('not reachable', 'ECONNRESET', true);
        }
        return { port: 8082 };
      },
    });
    expect(dials).toEqual([HOME, AWAY]); // one call, one re-choose, one retry
    expect(answer.starter).toBe(AWAY);
    expect(answer.body).toEqual({ port: 8082 });
    expect(calls).toEqual([`${HOME}/models`, `${HOME}/models`]);
  });

  it('names both addresses when the retry fails too', async () => {
    const answers: Record<string, Answer> = { [HOME]: { models: [] }, [AWAY]: { models: [] } };
    const { fetchImpl } = fakeFetch(answers);
    const router = new StarterRouter(() => 1_000, fetchImpl, atHome);
    const dials: string[] = [];
    const pending = router.call({
      urls: [HOME, AWAY],
      dial: async (starter) => {
        dials.push(starter);
        if (dials.length === 1) answers[HOME] = { code: 'ECONNRESET' };
        throw new StarterUnreachableError('not reachable', 'ECONNRESET', true);
      },
    });
    await expect(pending).rejects.toThrow(
      /not reachable at any configured address: http:\/\/192.0.2.10:8798 \(ECONNRESET\); http:\/\/100.64.0.10:8798 \(ECONNRESET\)/,
    );
    expect(dials).toEqual([HOME, AWAY]);
  });

  it('never switches on an HTTP status', async () => {
    const { fetchImpl } = fakeFetch({ [HOME]: { models: [] }, [AWAY]: { models: [] } });
    const router = new StarterRouter(() => 1_000, fetchImpl, atHome);
    const dials: string[] = [];
    // 409/422/404/502 are answers: re-choosing would send the same request to
    // the same desktop through another address and get the same refusal back.
    await expect(
      router.call({
        urls: [HOME, AWAY],
        dial: async (starter) => {
          dials.push(starter);
          throw new Error('Desktop is busy running strata-iq3s; try again when its turn ends.');
        },
      }),
    ).rejects.toThrow(/busy running strata-iq3s/);
    expect(dials).toEqual([HOME]);
  });

  it('retries nothing for a one-address config', async () => {
    const answers: Record<string, Answer> = {};
    const { calls, fetchImpl } = fakeFetch(answers);
    const router = new StarterRouter(() => 1_000, fetchImpl, atHome);
    const dials: string[] = [];
    // One address, nowhere to re-choose to: one attempt, no probe, and the
    // message this file has always had for a desktop that is not there.
    await expect(
      router.call({
        urls: [HOME],
        dial: async (starter) => {
          dials.push(starter);
          throw new StarterUnreachableError(
            'Desktop model starter not reachable at http://192.0.2.10:8798/ensure: is a ' +
              'Forge window open on the desktop, and is Tailscale up?',
            'ECONNREFUSED',
            true,
          );
        },
      }),
    ).rejects.toThrow(/not reachable at http:\/\/192.0.2.10:8798\/ensure/);
    expect(dials).toEqual([HOME]);
    expect(calls).toEqual([]); // no probe either: acceptance criterion 1
  });

  it('dials the address a lease was earned through, not the current winner', async () => {
    const { fetchImpl } = fakeFetch({ [HOME]: { models: [] }, [AWAY]: { models: [] } });
    const router = new StarterRouter(() => 1_000, fetchImpl, atHome);
    await router.routeFor({ urls: [HOME, AWAY] }); // winner: HOME
    const dials: string[] = [];
    const answer = await router.call({
      urls: [HOME, AWAY],
      preferredStarter: AWAY,
      dial: async (starter) => {
        dials.push(starter);
        return { port: 8091 };
      },
    });
    // `/release` and `/unload` go back the way the lease came, even though this
    // window would now dial HOME for a new request.
    expect(dials).toEqual([AWAY]);
    expect(answer.starter).toBe(AWAY);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
