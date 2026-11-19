/**
 * The one reader of the peer list inside `tailscale status --json`.
 *
 * Both desktop commands read that list, and both used to parse it against a shape
 * Tailscale never produces — `Peer` as an array, and a `NodeName` field that does
 * not exist — so each found zero peers against real output: Connect never offered
 * a device and Check connection never saw one. One owner here (CLAUDE.md "Single
 * Point of Truth"): `parseTailnetPeers` in `desktopConnectPlan.ts` filters this
 * for the picker, and `parseTailscaleView` in `desktopCheckTailscale.ts` keeps
 * the offline entries because a check has to name them.
 */

/** One peer of a `tailscale status --json` document, before the caller decides
 *  what to do with it. `online` is kept because a check has to name an offline
 *  desktop while a picker must never offer one. */
export interface TailscalePeer {
  name: string;
  addresses: string[];
  online: boolean;
}

/** Read the peers out of a parsed `tailscale status --json` document. The shape
 *  belongs to Tailscale and nowhere else: `Peer` is an OBJECT keyed by node key
 *  (never an array), this machine is the top-level `Self` rather than an entry in
 *  it, and an entry names itself with `DNSName` (`"desktop.example-tailnet.ts.net."`,
 *  trailing dot) and `HostName` — there is no `NodeName` to read. Anything else
 *  shape comes back as an empty list, so the caller asks for an address instead
 *  of pretending to know the tailnet. IPv6 addresses are dropped, because
 *  `tailscale serve` forwards the tailnet IPv4 the peer's `TailscaleIPs` carries
 *  first. */
export function tailscaleStatusPeers(doc: unknown): TailscalePeer[] {
  const record = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  const peerMap = record.Peer;
  if (!peerMap || typeof peerMap !== 'object' || Array.isArray(peerMap)) return [];
  const out: TailscalePeer[] = [];
  for (const raw of Object.values(peerMap as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const peer = raw as Record<string, unknown>;
    if (peer.Self === true) continue;
    const dnsName = typeof peer.DNSName === 'string' ? peer.DNSName : '';
    const hostName = typeof peer.HostName === 'string' ? peer.HostName : '';
    const name = (dnsName || hostName).split('.')[0] ?? '';
    const addresses = Array.isArray(peer.TailscaleIPs)
      ? peer.TailscaleIPs.filter(
          (value): value is string => typeof value === 'string' && /^\d+(\.\d+){3}$/.test(value), // IPv4 only
        )
      : [];
    if (!name || !addresses.length) continue;
    out.push({ name, addresses, online: peer.Online === true });
  }
  return out;
}
