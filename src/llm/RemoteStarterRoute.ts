/**
 * Which of the addresses in `remote_start.starter` this laptop should use
 * (docs/plans/LAPTOP_LAN_ACCESS_PLAN.md Phase 1, "Autoswitch").
 *
 * A laptop has two ways to reach the desktop — the LAN forwarder at home, the
 * tailnet address when away — and which one works depends on where the laptop
 * is, not on what its config says. So the config lists both, in that order, and
 * this file decides which to dial: probe each address in config order with
 * `GET /models` and use the first that answers like a Forge model starter.
 *
 * It also remembers the answer, because choosing on every request would cost a
 * round trip per prompt: `StarterRouter` below holds the winner, the network it
 * was chosen on and the last time it answered, and applies the plan's re-choose
 * rules (a)-(d). Which address to dial is therefore owned here, and what to ask
 * of it (leases, ports, heartbeats) stays in `RemoteStarterClient.ts`.
 *
 * The probe has to be a real request that has to be answered, not a TCP
 * connect: on a network that happens to hand out the desktop's LAN address to
 * something else, the address answers HTTP just fine and even 200, but not with
 * a `models` list, so it does not win. And the LAST address is never probed —
 * the `/ensure` sent to it reports its own failure — because away mode would
 * otherwise pay the same round trip twice.
 *
 * No probing and no choosing at all for a one-address config: that is the
 * behaviour that shipped in 0.17.84, and it must stay exactly as it was.
 */

import * as os from 'os';
import { getLogger } from '../util/logger';
import { StarterUnreachableError, failureReasonOf, readJsonObject } from './RemoteStarterHttp';

/** A probe is `GET /models` against a machine we only HOPE is a Forge starter:
 *  2.5 s is long enough for a LAN round trip and for a tailnet hole punch, and
 *  short enough that a laptop which has just walked onto a café network is not
 *  held up for minutes before it finds the address that works. */
const PROBE_TIMEOUT_MS = 2_500;

/** An address that was tried, and why it did not work: one entry of the message
 *  that names every configured address rather than only the last one. */
export interface StarterFailure {
  url: string;
  reason: string;
}

/** What probing the configured addresses in order produced: the address to use,
 *  and every address tried before it with its reason. */
export interface StarterChoice {
  starter: string;
  failures: StarterFailure[];
}

/** A probe's answer: won, or lost with the short phrase the all-failed message
 *  will show for it. */
type ProbeOutcome = { alive: true } | { alive: false; reason: string };

/**
 * One probe: `GET <url>/models` with the 2.5 s timeout. A Forge starter wins it
 * by answering 200 with a JSON body holding a `models` array — that is the check
 * that makes probing worth doing at all, and why a device that merely has the
 * address does not capture the route.
 *
 * Throws only when the CALLER'S signal aborts. A cancelled probe is not that
 * address's failure: recording it as one would let a user's Stop be answered
 * with the next address and then overwritten by this window's cancellation.
 */
async function probeStarter(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, PROBE_TIMEOUT_MS);
  timer.unref?.();
  const forwardAbort = (): void => ctrl.abort();
  if (signal?.aborted) {
    // An already-cancelled signal has to cut the probe before it leaves, the
    // same way `RemoteStarterClient.post` handles it: `addEventListener` would
    // never fire for a signal that is already done.
    ctrl.abort();
  } else {
    signal?.addEventListener('abort', forwardAbort);
  }
  try {
    const response = await fetchImpl(new URL('/models', url).toString(), {
      method: 'GET',
      signal: ctrl.signal,
    });
    const body = await readJsonObject(response);
    if (!response.ok) return { alive: false, reason: `HTTP ${response.status}` };
    if (!Array.isArray(body.models)) {
      return { alive: false, reason: 'HTTP 200 without a "models" list' };
    }
    return { alive: true };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut) return { alive: false, reason: `timed out after ${PROBE_TIMEOUT_MS / 1000} s` };
    // `failureReasonOf` prefers the error's code (`ECONNRESET`), which is what
    // the user can act on; a bare "fetch failed" tells them nothing.
    return { alive: false, reason: failureReasonOf(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * Choose the address to use, in config order, and report what it cost to choose
 * it. One address is returned as-is with no probe; several are probed until one
 * answers, and if none does the LAST one is handed back unprobed because its
 * `/ensure` will report its own failure.
 *
 * `urls` is never empty: `remote_start.starter` is one URL or 1-4 of them, and
 * the schema refuses an empty list.
 *
 * Throws only on the caller's abort, for the same reason `probeStarter` does.
 */
export async function chooseStarter(
  urls: string[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<StarterChoice> {
  const failures: StarterFailure[] = [];
  if (urls.length === 1) return { starter: urls[0]!, failures };
  for (const url of urls.slice(0, -1)) {
    const probe = await probeStarter(url, fetchImpl, signal);
    if (probe.alive) return { starter: url, failures };
    failures.push({ url, reason: probe.reason });
  }
  return { starter: urls[urls.length - 1]!, failures };
}

/**
 * The network this window is on: the sorted, de-duplicated non-internal IPv4
 * addresses from `os.networkInterfaces()`. Interfaces are injectable because a
 * unit test cannot depend on what machine CI is running on.
 *
 * Addresses only — not names, masks or MACs — because the point is to notice
 * that the laptop changed networks, and the addresses are what change when it
 * does. A network that hands out the SAME addresses (a café that also uses
 * 192.168.1.x) is invisible here, which is why the client re-verifies the route
 * by probe as well (rule d).
 */
export function networkFingerprint(
  interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces,
): string {
  const addresses = new Set<string>();
  for (const entries of Object.values(interfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses].sort().join(',');
}

/**
 * The message when no configured address answered: every address named with its
 * reason, then the three things that could be wrong (docs/plans/
 * LAPTOP_LAN_ACCESS_PLAN.md, "Errors"). A laptop that walked through the whole
 * list has to be told which address failed and why — "not reachable" alone
 * leaves the user guessing whether the problem is at home or away.
 */
export function allStarterFailedMessage(failures: StarterFailure[]): string {
  const named = failures.map((failure) => `${failure.url} (${failure.reason})`).join('; ');
  return (
    `Desktop model starter not reachable at any configured address: ${named}. ` +
    'At home: is the desktop\u2019s LAN forwarder on? Away: is Tailscale up? Either way: ' +
    'is a Forge window open on the desktop with model_starter.enabled: true?'
  );
}

// ── the address, remembered ──────────────────────────────────────────────────

const log = getLogger();

/** How recently the remembered address must have answered for a cached lease to
 *  be reused with no request at all — rule (d)'s clock. A laptop that moves to a
 *  network handing out the SAME addresses is invisible to the fingerprint, so
 *  this clock is the only thing that catches it; at home the probe it triggers
 *  costs milliseconds, at most once a minute. */
const CONTACT_FRESH_MS = 60_000;

/** What the router reports after deciding which address to use: the address, the
 *  ones tried before it, and whether the caller has to throw its cached leases
 *  away. They do whenever the route changed underneath them — the network
 *  changed, or the address they were earned through stopped answering — because
 *  each cached base URL was built on the host of the address that answered, and
 *  that host may now be a machine this window cannot reach at all. */
export interface StarterRoute {
  starter: string;
  failures: StarterFailure[];
  leasesMustDrop: boolean;
}

/** The two things choosing an address needs: the addresses in config order, and
 *  the caller's cancel signal, which is NOT a failure of any of them. */
export interface RouteRequest {
  urls: string[];
  signal?: AbortSignal | undefined;
}

/** One call the router is asked to place. `dial` makes the actual POST to the
 *  address the router chose: the router owns WHICH address and never what is
 *  asked of it, so it can retry through another one without knowing anything
 *  about leases, ports or model names. */
export interface RouterCall<T> extends RouteRequest {
  /** The address to try first when this call answers for a lease earned through
   *  another one: renew, `/unload` and `/release` go back the way the lease came. */
  preferredStarter?: string | undefined;
  /** A route the caller already resolved, so one address is not chosen (and one
   *  network not read) twice for a single request. */
  route?: StarterRoute | undefined;
  dial: (starter: string) => Promise<T>;
}

/**
 * The window's memory of which starter answered, on which network, and when —
 * the plan's re-choose rules (a)-(d) in one place, so "which address am I
 * dialing, and when do I have to choose again" has one owner.
 *
 * The memory is per-window and never written to disk: a preference kept across
 * restarts would send a home laptop through Tailscale for no reason (decision
 * D4). It is also why each cached lease carries its own starter: a lease earned
 * through one address is only reusable while that address is still the route.
 */
export class StarterRouter {
  private remembered: { starter: string; fingerprint: string; lastContact: number } | undefined;

  constructor(
    private readonly now: () => number,
    private readonly fetchImpl: typeof fetch,
    private readonly fingerprint: () => string,
  ) {}

  /** The address to use now: the remembered one while the network still matches
   *  it, otherwise a fresh choice from the first configured address (rule a). A
   *  different fingerprint is rule (b) — the laptop moved networks — and it is
   *  reported as `leasesMustDrop`, because every cached base URL was built on a
   *  host this window may no longer be able to reach. */
  async routeFor({ urls, signal }: RouteRequest): Promise<StarterRoute> {
    const fingerprint = this.fingerprint();
    const moved = this.remembered !== undefined && this.remembered.fingerprint !== fingerprint;
    if (moved) this.remembered = undefined;
    if (this.remembered) {
      return { starter: this.remembered.starter, failures: [], leasesMustDrop: false };
    }
    return this.remember(await chooseStarter(urls, this.fetchImpl, signal), fingerprint, moved);
  }

  /** Rule (d)'s clock: the remembered address answered within `CONTACT_FRESH_MS`,
   *  so a cached lease can be reused with no request at all. */
  contactIsFresh(): boolean {
    const route = this.remembered;
    return route !== undefined && this.now() - route.lastContact <= CONTACT_FRESH_MS;
  }

  /** Rule (d): the remembered address has gone quiet and a cached lease is about
   *  to be reused, so re-verify it with one probe first. If it answers, the lease
   *  stands; if it does not, re-choose from the first configured address and
   *  report the leases as dropped — a café network that also hands out
   *  192.168.1.x would otherwise keep a laptop dialing a machine that is not
   *  there for the rest of the lease. */
  async reverifyRoute({ urls, signal }: RouteRequest): Promise<StarterRoute> {
    const route = this.remembered;
    if (!route) return this.routeFor({ urls, signal });
    const probe = await probeStarter(route.starter, this.fetchImpl, signal);
    if (probe.alive) {
      route.lastContact = this.now();
      return { starter: route.starter, failures: [], leasesMustDrop: false };
    }
    return this.remember(
      await chooseStarter(urls, this.fetchImpl, signal),
      this.fingerprint(),
      true,
    );
  }

  /**
   * Place one call through the chosen address, with the plan's one retry
   * (rule c): an unreachable failure re-chooses from the FIRST configured
   * address and retries exactly once. An HTTP status from the desktop
   * (409/422/404/502) is an answer, never a reason to switch, and a one-address
   *  config has nowhere to re-choose to — it makes one call and its message
   *  stays exactly what it was before any list existed. When the retry also
   *  fails, the message names every address with its reason.
   */
  async call<T>({
    urls,
    signal,
    preferredStarter,
    route: chosen,
    dial,
  }: RouterCall<T>): Promise<{ body: T; starter: string }> {
    const route = chosen ?? (await this.routeFor({ urls, signal }));
    const starter = preferredStarter ?? route.starter;
    try {
      return { body: await this.dialThrough(dial, starter), starter };
    } catch (error) {
      // Only a dead path is worth re-choosing over, and only when there is
      // another address to choose from.
      if (!(error instanceof StarterUnreachableError) || !error.switchRoute || urls.length < 2) {
        throw error;
      }
      const choice = await chooseStarter(urls, this.fetchImpl, signal);
      const retryRoute = this.remember(choice, this.fingerprint(), false);
      try {
        return {
          body: await this.dialThrough(dial, retryRoute.starter),
          starter: retryRoute.starter,
        };
      } catch (retryError) {
        if (!(retryError instanceof StarterUnreachableError)) throw retryError;
        // Every address this window has now tried, in config order, with its
        // reason — including any after the chosen one, which were never reached
        // because an earlier address answered the probe.
        throw new Error(
          allStarterFailedMessage([
            ...choice.failures,
            { url: retryRoute.starter, reason: retryError.reason },
            ...urls.slice(urls.indexOf(retryRoute.starter) + 1).map((url) => ({
              url,
              reason: 'not tried, an earlier address answered',
            })),
          ]),
          { cause: retryError },
        );
      }
    }
  }

  /** One attempt, and the contact its answer counts as: a call that answers is
   *  what stops rule (d) from re-verifying a live address a minute later for
   *  nothing. Only the remembered route counts — an address dialed because a
   *  lease was earned through it is on its way out, not being kept. */
  private async dialThrough<T>(dial: (starter: string) => Promise<T>, starter: string): Promise<T> {
    const value = await dial(starter);
    if (this.remembered?.starter === starter) this.remembered.lastContact = this.now();
    return value;
  }

  /** Record a choice, and say once when the address changed: that line is how
   *  the live test proves which route a laptop actually used. */
  private remember(
    choice: StarterChoice,
    fingerprint: string,
    leasesMustDrop: boolean,
  ): StarterRoute {
    const previous = this.remembered?.starter;
    // Chosen now: the probe that won, or the call this choice is about to be
    // used for, is the first contact. A choice that fails that contact is never
    // remembered with a lease to reuse, so this cannot make rule (d) skip an
    // address that has never answered.
    this.remembered = { starter: choice.starter, fingerprint, lastContact: this.now() };
    if (previous && previous !== choice.starter) {
      log.info(`[RemoteStarterRoute] desktop starter: ${choice.starter} (was ${previous})`);
    }
    return { starter: choice.starter, failures: choice.failures, leasesMustDrop };
  }
}
