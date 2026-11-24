import { isIP } from 'net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { ForgeConfig } from '../config/types';
import { normalizedHostname } from './fetchHostApprovals';

// ── SSRF guard ────────────────────────────────────────────────────────────────

export class ToolError extends Error {}

const BLOCKED_SCHEMES = ['file://', 'data:', 'javascript:'];
export const MAX_REDIRECT_HOPS = 3;
export const REQUEST_TIMEOUT_MS = 10_000;
export const USER_AGENT = 'Forge-VSCode (local-llm assistant)';
export interface ResolvedAddress {
  address: string;
  family: number;
}

interface RequestInitWithSignal {
  redirect: 'manual';
  signal: AbortSignal;
  method: string;
  body?: Uint8Array;
  headers: Record<string, string>;
}

export type PinnedFetch = (
  url: string,
  address: ResolvedAddress,
  init: RequestInitWithSignal,
  agent: Agent,
) => Promise<Response>;

export interface WebFetchDependencies {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  fetch?: PinnedFetch;
  /** The config, for `fetch.allowed_hosts`. Absent means no host is
   *  pre-approved, which is the safe direction: everything asks. */
  getConfig?: () => ForgeConfig;
}

export function parseFetchUrl(value: string): URL | string {
  for (const scheme of BLOCKED_SCHEMES) {
    if (value.toLowerCase().startsWith(scheme)) return `Blocked scheme: ${scheme}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Invalid URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Blocked scheme: ${url.protocol}`;
  }
  const hostname = normalizedHostname(url);
  if (!hostname.includes('.')) return `Blocked: hostname has no dot: ${hostname}`;
  if (isIP(hostname) !== 0) return `Blocked: raw IP address not permitted: ${hostname}`;
  return url;
}

function parseIpv6(address: string): number[] | undefined {
  let value = address.toLowerCase().split('%')[0] ?? '';
  if (!value.includes(':')) return undefined;
  const lastColon = value.lastIndexOf(':');
  const dotted = value.slice(lastColon + 1);
  if (dotted.includes('.')) {
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part > 255)) {
      return undefined;
    }
    const firstGroup = (((octets[0] as number) << 8) | (octets[1] as number)).toString(16);
    const secondGroup = (((octets[2] as number) << 8) | (octets[3] as number)).toString(16);
    value = `${value.slice(0, lastColon + 1)}` + `${firstGroup}:${secondGroup}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[\da-f]{1,4}$/i.test(part))) {
    return undefined;
  }
  return groups.map((part) => Number.parseInt(part, 16));
}

function blockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family !== 6) return true;
  const groups = parseIpv6(address);
  if (!groups) return true;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((groups[0] as number) >= 0xfc00 && (groups[0] as number) <= 0xfdff) return true;
  if ((groups[0] as number) >= 0xfe80 && (groups[0] as number) <= 0xfebf) return true;
  if (groups.slice(0, 6).every((group) => group === 0)) {
    const compatibleIpv4 = [
      ((groups[6] as number) >> 8) & 0xff,
      (groups[6] as number) & 0xff,
      ((groups[7] as number) >> 8) & 0xff,
      (groups[7] as number) & 0xff,
    ].join('.');
    return blockedIpv4(compatibleIpv4);
  }
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mappedIpv4 = [
      ((groups[6] as number) >> 8) & 0xff,
      (groups[6] as number) & 0xff,
      ((groups[7] as number) >> 8) & 0xff,
      (groups[7] as number) & 0xff,
    ].join('.');
    return blockedIpv4(mappedIpv4);
  }
  // Only global unicast is a place a public page can live. Everything else in
  // IPv6 is reserved space or a transition address that carries an IPv4 inside
  // it, and none of it reaches the tests above: 6to4 `2002::/16` (so
  // `2002:7f00:1::` is 127.0.0.1 and `2002:a9fe:8064::` is 169.254.128.100),
  // Teredo `2001::/32`, documentation `2001:db8::/32`, the DNS64/NAT64
  // well-known prefix `64:ff9b::/96`, and multicast `ff00::/8`. Refusing
  // everything outside `2000::/3` closes all of those at once, and closes any
  // space nobody has assigned yet too - refused rather than allowed.
  const head = groups[0] as number;
  if (head < 0x2000 || head > 0x3fff) return true;
  if (head === 0x2002) return true;
  if (head === 0x2001 && ((groups[1] as number) === 0 || (groups[1] as number) === 0x0db8)) {
    return true;
  }
  return false;
}

export function blockedResolvedAddress(address: ResolvedAddress): string | undefined {
  if (address.family !== isIP(address.address) || blockedAddress(address.address)) {
    return `Blocked private, loopback, or reserved address: ${address.address}`;
  }
  return undefined;
}

/**
 * Validate the URL's shape before DNS resolution. Resolved addresses are
 * checked separately immediately before each connection.
 */
export function ssrfCheck(url: string): string | null {
  const parsed = parseFetchUrl(url);
  return typeof parsed === 'string' ? parsed : null;
}

export function defaultPinnedFetch(
  url: string,
  _address: ResolvedAddress,
  init: RequestInitWithSignal,
  agent: Agent,
): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    dispatcher: agent,
  } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

/**
 * Hand the connector EVERY address the guard vetted, not just the first one.
 * `net.connect` fails over between the addresses a lookup returns (Happy
 * Eyeballs), so a host whose first answer is blackholed still connects; given
 * one address, it cannot. Handing one made every IPv6-first host unreachable
 * on a line with a broken IPv6 route — `curl -6 https://cdn.jsdelivr.net/...`
 * timing out while `curl -4` answered 200 in 60 ms, and the preview reporting
 * `net::ERR_FAILED` after the 10 s hop limit (measured 2026-11-24). Nothing new
 * is resolved here: the list is exactly what `blockedResolvedAddress` accepted.
 */
export function createPinnedAgent(pins: Map<string, ResolvedAddress[]>): Agent {
  return new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        const vetted = pins.get(hostname.toLowerCase());
        if (!vetted || vetted.length === 0) {
          callback(new Error(`No vetted address for ${hostname}`), '', 0);
          return;
        }
        if (options.all)
          callback(
            null,
            vetted.map((pin) => ({ address: pin.address, family: pin.family })),
          );
        else {
          const first = vetted[0] as ResolvedAddress;
          callback(null, first.address, first.family);
        }
      },
    },
  });
}
