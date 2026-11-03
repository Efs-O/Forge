/**
 * Single owner for "which TCP ports will `fetch()` refuse before it ever
 * contacts the host?".
 *
 * The WHATWG Fetch standard blocks a fixed list of ports, and Node's `fetch`
 * enforces it: `fetch('http://127.0.0.1:6000')` fails with "bad port" without
 * sending a packet, whatever is listening there. A machine whose dynamic port
 * range starts at 1024 — `netsh int ipv4 show dynamicport tcp` reports exactly
 * that here — can therefore hand `server.listen(0)` a port its own client
 * cannot use. Anything that binds an ephemeral port and then polls it with
 * `fetch` must rebind past these, or a healthy server reads as a dead one.
 *
 * WHATWG Fetch Standard § 2.9 "Port blocking":
 * https://fetch.spec.whatwg.org/#port-blocking
 *
 * Port 0 is in the list on purpose: it is what an unbound socket reports, so a
 * caller that treats "no port" as "a free port" is caught by the same check.
 */
const FETCH_BLOCKED_PORTS = new Set<number>([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/** True when `fetch()` refuses `port` outright, before anything on it is reached. */
export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}
