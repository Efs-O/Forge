/**
 * This computer's `tailscale status --json` for `Forge: Check connection`: the
 * daemon's own state, the peers it sees (offline ones included), and which of
 * the configured dial addresses belong to the tailnet rather than the LAN.
 *
 * Split out of `desktopCheckConnection.ts`, which owns the walk and calls these
 * at links 1 and 2 only. The peer entries themselves come from
 * `tailscalePeers.ts`, the one reader of that shape.
 */

import { tailscaleStatusPeers } from './tailscalePeers';
import { TAILSCALE_READ_TIMEOUT_MS, runTailscaleCli } from './tailscaleCli';
import { errText } from './desktopConnect';
import type { DesktopCheckDeps } from './desktopCheckConnection';

/** `tailscale status --json`, read only. A failure is returned, not thrown: the
 *  first link of the chain IS this read, so the walk has to be able to report it. */
export async function readTailscaleStatus(
  deps: DesktopCheckDeps,
  signal: AbortSignal,
): Promise<TailscaleView> {
  try {
    const json = await (deps.runTailscale ?? defaultRunTailscale)(['status', '--json'], signal);
    return parseTailscaleView(json);
  } catch (error) {
    // A cancelled read is not the daemon's failure. `RemoteStarterRoute`'s probe
    // follows the same rule and for the same reason: reporting a window that
    // closed as "Tailscale is not running on this computer" would send the owner
    // to fix a thing that was never broken.
    if (signal.aborted) throw error;
    return { state: null, tailnet: null, peers: [], failure: errText(error) };
  }
}

function defaultRunTailscale(args: string[], signal?: AbortSignal): Promise<string> {
  return runTailscaleCli(args, { timeoutMs: TAILSCALE_READ_TIMEOUT_MS, signal });
}

/** What this computer's Tailscale says about itself and the machines it sees.
 *  Its own parse of the JSON, deliberately not `parseTailnetPeers` from
 *  `desktopConnectPlan.ts`: Connect wants only the online devices because it is
 *  offering them in a picker, while a check has to name an offline desktop and
 *  say so — and it needs the daemon's own state, which the picker never asks
 *  for. The peer entries themselves come from `tailscaleStatusPeers`, the one
 *  reader of that shape, so a Tailscale that changes it costs a note here rather
 *  than a crash. */
export interface TailscaleView {
  state: string | null;
  tailnet: string | null;
  peers: Array<{ name: string; addresses: string[]; online: boolean }>;
  failure: string | null;
}

function parseTailscaleView(json: string): TailscaleView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return {
      state: null,
      tailnet: null,
      peers: [],
      failure: 'Tailscale answered something that is not JSON',
    };
  }
  const doc = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const peers = tailscaleStatusPeers(doc);
  const tailnet = (doc.CurrentTailnet as Record<string, unknown> | undefined)?.MagicDNSSuffix;
  return {
    state: typeof doc.BackendState === 'string' ? doc.BackendState : null,
    tailnet: typeof tailnet === 'string' && tailnet.length ? tailnet : null,
    peers,
    failure: null,
  };
}

/** The Tailscale address ranges: the CGNAT block Tailscale hands out (100.64.0.0/10)
 *  and its ULA IPv6 range (fc00::/7, which in practice means `fd…`). Anything else
 *  is a LAN or some other address, which is why a failure of Tailscale here does
 *  not necessarily end the walk. */
export function isTailnetHost(host: string): boolean {
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  const match = host.match(/^100\.(\d{1,3})\./);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 64 && second <= 127;
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return url;
  }
}
