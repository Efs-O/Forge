/**
 * The pure half of "Forge: Connect to my desktop" (docs/plans/V1_FINISH_PLAN.md
 * lane 3 phase 3.2, built on docs/plans/IMPORT_DESKTOP_MODELS_PLAN.md).
 *
 * One command replaces the seventeen hand-written laptop entries that setting up
 * the laptop used to cost. It reads the desktop's two lists (`GET /models` on the
 * model starter, `GET /v1/models` on the cloud relay — both read-only, so nothing
 * is started, loaded or leased) and writes an entry for EVERY model the desktop
 * will serve: there is no picking list, and the models the desktop refuses are
 * reported with the desktop's own reason rather than quietly dropped.
 *
 * Three rules are what make this safe to run on a config the owner built by
 * hand, and this file is where they are decided rather than where they are
 * enforced:
 *
 * 1. An entry whose name already exists is never touched. It is counted as
 *    "already there" and its bytes must come out of the write identical — the
 *    owner's hand-written `sampling`, comment or `display_name` is theirs, not
 *    the tool's. There is no three-way choice: re-running Connect after deleting
 *    an entry is how a changed entry is replaced.
 * 2. Exactly one `updateConfigFile` call for the whole run, so the config either
 *    has all the new entries or none, and every entry written has to parse with
 *    `ForgeConfigSchema` before the atomic rename.
 * 3. No key, ever. The relay resolves its own tokens on the desktop, so a
 *    laptop entry for a cloud model is a `group` and a name — nothing secret.
 *
 * Since the pass-through (phase 3.1) a new entry points at the desktop's ONE
 * shared port with the desktop's model name as a path prefix, so a new desktop
 * model needs no new `tailscale serve` share, no new ACL line and no
 * `shared_ports` entry. A desktop too old to report a shared port keeps the old
 * direct-port shape, and that is decided here rather than guessed later.
 */

import { normalizeOpenAiCompatibleBaseUrl } from '../llm/CloudProviders';
import * as net from 'net';
import type { RelayModelRow } from '../llm/RemoteStarterHttp';
import type { ForgeConfig, ModelConfig } from '../config/types';

/** One entry of `groups:` — `GroupSchema`'s shape, taken from the parsed config
 *  so a Connect-created group cannot drift from what the schema accepts. */
export type GroupShape = NonNullable<ForgeConfig['groups']>[string];

/** The two groups the relay entries go in, spelled as the owner's laptop config
 *  spells them (`docs/plans/LAPTOP_FORGE_CONFIG.relay.yaml`). Keeping the names
 *  is the point: an entry the owner already wrote for `desktop-relay` must land
 *  in the same group Connect creates, not beside a near-miss of it. */
export const RELAY_GROUPS = { openai: 'desktop-relay', ollama: 'ollama-cloud' } as const;

/** The capabilities `CapabilitiesSchema` accepts. A capability the desktop reports
 *  that is NOT in this list is dropped rather than written: an unknown string
 *  would fail `ForgeConfigSchema` and refuse the WHOLE write, so one desktop
 *  build inventing a new capability could not stop a laptop from getting the
 *  other sixteen models it was told about. */
const KNOWN_CAPABILITIES = ['tool-call', 'vision', 'long-context'] as const;

/** One model as `GET /models` reported it. Only the fields a laptop entry can
 *  carry are read: `loaded` and `leasedBy` are deliberately NOT read, because an
 *  entry must not depend on what the desktop happens to have loaded at the
 *  moment of the read — the laptop ensures on its next request. */
export interface DesktopModelRow {
  name: string;
  display_name?: unknown;
  /** `remote: true` is the pass-through's target set; anything else is refused
   *  with the desktop's reason and never written. */
  remote: boolean;
  reason?: unknown;
  context?: unknown;
  capabilities?: unknown;
  model?: unknown;
  token_count?: unknown;
  reasoning_effort?: unknown;
}

/** Where the entries point, decided by the caller (which address answered, and
 *  what the desktop reported): this file never dials anything. */
export interface ConnectTargets {
  /** The starter addresses, in the order they will be written into every entry.
   *  Never empty: `remote_start.starter` needs 1-4 and the schema refuses zero. */
  starters: string[];
  /** The port model traffic comes through: the desktop's `shared_port` from
   *  `GET /models`. `null` when the desktop did not report one, which means it is
   *  a build from before the pass-through: it cannot serve a model whose slot port
   *  it has not already shared, so no entry can be written for it and the
   *  message has to say why rather than write something that will 404. */
  sharedPort: number | null;
  /** `http://<host>:<port>` of the desktop's cloud relay, or null when no relay
   *  answered — then the desktop models are still written and the caller says
   *  the cloud list was not read. */
  relay: string | null;
  /** Why the relay did not answer, when it did not: `null` when it did, or when
   *  none was tried. Without this the plan could not tell "the desktop has no
   *  cloud models" from "the desktop's relay is off", and the owner would be
   *  left to guess which of the two a short list meant. */
  relayFailure?: string | null;
}

export interface ConnectPlan {
  /** Entries to append, in the order the desktop listed them. */
  entries: ModelConfig[];
  /** Groups to create — only the ones this config does not already have, so an
   *  existing group's endpoint (and its comment) is never rewritten. */
  groups: Record<string, GroupShape>;
  /** Names already in the config: left byte-identical, never rewritten. */
  alreadyThere: string[];
  /** Models the desktop refused, with the reason the desktop gave. */
  refused: Array<{ name: string; reason: string }>;
  /** Models the desktop WOULD serve but this run could not write, with why —
   *  a desktop that predates the pass-through is the only case, and it needs an
   *  update on the DESKTOP, so it is reported apart from the refusals. */
  notAdded: Array<{ name: string; why: string }>;
  /** What could not be written, in the owner's words, for the result message. */
  notes: string[];
}

/** The whole run's writes, from the two desktop lists plus the config as it
 *  stands. Pure: no fetch, no file, no vscode, so the tests drive every branch
 *  of the field table and the "already there" rule without a laptop. */
export function planConnect(
  models: DesktopModelRow[],
  relayModels: RelayModelRow[],
  config: ForgeConfig,
  targets: ConnectTargets,
): ConnectPlan {
  const plan: ConnectPlan = {
    entries: [],
    groups: {},
    alreadyThere: [],
    refused: [],
    notAdded: [],
    notes: [],
  };
  // One set for the whole run: a name already in the config, or already added by
  // this run, is never added twice — a desktop that lists the same name twice, or
  // a starter model and a relay model that share a name, must not produce two
  // entries the schema would then refuse as duplicates.
  const taken = new Set(config.models.map((model) => model.name));
  // Hoisted so the null case is checked once per run and the entry builder sees a
  // plain number: a property of a parameter object is not something the entry
  // builder should have to re-prove.
  const sharedPort = targets.sharedPort;
  for (const row of models) {
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) continue;
    if (taken.has(name)) {
      plan.alreadyThere.push(name);
      continue;
    }
    if (row.remote !== true) {
      plan.refused.push({
        name,
        reason: typeof row.reason === 'string' ? row.reason : 'not remotely servable',
      });
      continue;
    }
    if (sharedPort === null) {
      // Nothing to point the entry at: a desktop that does not report its shared
      // port cannot be asked for a model through one port, and guessing the
      // slot port is the defect `LAPTOP_MODEL_STARTER_PLAN.md` problem 3 was.
      plan.notAdded.push({
        name,
        why: 'this desktop does not report a shared port — update Forge on the desktop',
      });
      continue;
    }
    taken.add(name);
    plan.entries.push(desktopEntry(row, name, targets, sharedPort, plan.notes));
  }
  if (targets.relay) {
    for (const row of relayModels) {
      const name = row.id.trim();
      if (!name || taken.has(name)) {
        if (name && taken.has(name)) plan.alreadyThere.push(name);
        continue;
      }
      taken.add(name);
      const group = RELAY_GROUPS[row.kind === 'ollama' ? 'ollama' : 'openai'];
      plan.entries.push({ name, group });
      // Only a group this config does not have. An existing one may point at a
      // different host (a laptop that moved networks and was edited by hand),
      // and rewriting it would change entries Connect was not asked to touch.
      if (!config.groups?.[group]) plan.groups[group] = relayGroup(group, targets.relay);
    }
  } else if (targets.relayFailure) {
    plan.notes.push(
      `The desktop cloud relay did not answer (${targets.relayFailure}), so no cloud models were added.`,
    );
  }
  return plan;
}

/** One laptop entry for a desktop model, filled from the fields the desktop
 *  reported. Missing or unusable fields are left out rather than guessed, and
 *  each omission is said in `notes` — the owner has to know what still has to be
 *  set by hand, which is the defect `IMPORT_DESKTOP_MODELS_PLAN.md`'s open
 *  question 1 was about. */
function desktopEntry(
  row: DesktopModelRow,
  name: string,
  targets: ConnectTargets,
  sharedPort: number,
  notes: string[],
): ModelConfig {
  const entry: ModelConfig = {
    name,
    // The schema allows `remote_start` on nothing else, and the desktop's
    // servability matrix already resolved provider + endpoint for us.
    provider: 'openai-compatible',
    endpoint: sharedEndpoint(targets.starters[0]!, name, sharedPort),
    // Written out even when it equals `name`: the two configs name the same
    // server differently as a rule, and this field exists for that case.
    remote_start: { starter: [...targets.starters], model: name },
  };
  const context = Number(row.context);
  if (Number.isInteger(context) && context > 0) entry.num_ctx = context;
  else notes.push(`"${name}": the desktop reported no usable context, so num_ctx is not set.`);
  const capabilities = Array.isArray(row.capabilities)
    ? row.capabilities.filter(
        (item): item is (typeof KNOWN_CAPABILITIES)[number] =>
          typeof item === 'string' && (KNOWN_CAPABILITIES as readonly string[]).includes(item),
      )
    : [];
  // Omitted when empty: `CapabilitiesSchema` is an optional array and an empty
  // one would say "this model does nothing", which is not the same as "unknown".
  if (capabilities.length) entry.capabilities = capabilities;
  const displayName = typeof row.display_name === 'string' ? row.display_name.trim() : '';
  // `display_name` is capped at 60 in `modelSchema.ts`: copied only when it
  // differs from the name and fits, never truncated behind the owner's back.
  if (displayName && displayName !== name) {
    if (displayName.length <= 60) entry.display_name = displayName;
    else
      notes.push(
        `"${name}": its desktop display name is longer than 60 characters, so it was not copied.`,
      );
  }
  const servedId = typeof row.model === 'string' ? row.model.trim() : '';
  if (servedId) entry.model = servedId;
  const tokenCount = typeof row.token_count === 'string' ? row.token_count : '';
  if (tokenCount === 'count_tokens' || tokenCount === 'estimate') {
    entry.token_count = tokenCount;
  } else if (tokenCount === 'tokenize') {
    // `/tokenize` is a llama-server route outside `/v1`, and the pass-through
    // carries only the OpenAI-shaped paths, so a laptop that copied `tokenize`
    // would have a tokenizer that 404s. Left unset means `estimate`.
    notes.push(
      `"${name}": the desktop tokenizes with /tokenize, which the shared port does not carry, ` +
        'so token_count is left unset (counts are estimated).',
    );
  }
  const effort = typeof row.reasoning_effort === 'string' ? row.reasoning_effort : '';
  // `exactOptionalPropertyTypes`: an optional field must be ABSENT, not present
  // with the value `undefined`, so the empty case is left out entirely rather
  // than written as `reasoning_effort: undefined`.
  if (effort) entry.reasoning_effort = effort as NonNullable<ModelConfig['reasoning_effort']>;
  return entry;
}

/** `http://<host the laptop dials>:<shared port>/<model name>` — the shape the
 *  pass-through answers. The HOST is taken from the first configured starter
 *  address because `validateRemoteStartEntry` requires `endpoint` and
 *  `remote_start.starter` to name the same machine, and `RemoteStarterClient`
 *  rebuilds the host from whichever address actually answered anyway. An IPv6
 *  literal keeps the brackets `URL` parsing gives it, which is what makes
 *  `endpoint` and `starter` agree for a `[fd00::1]:8798` desktop.
 *
 *  Deliberately NOT run through `normalizeOpenAiCompatibleBaseUrl`: that helper
 *  strips a trailing `/v1`, and a desktop model actually named `v1` would lose
 *  its prefix here and then 404 on every request. A name that odd is worth
 *  reporting rather than silently rewriting. */
export function sharedEndpoint(starter: string, modelName: string, sharedPort: number): string {
  const url = new URL(starter);
  url.port = String(sharedPort);
  url.pathname = `/${modelName}`;
  return url.toString().replace(/\/$/, '');
}

/** The group shape from `docs/plans/LAPTOP_FORGE_CONFIG.relay.yaml`, with the
 *  endpoint pointed at THIS desktop's relay. The Ollama group keeps `think` and
 *  the medium reasoning default the owner's group carries, because an entry that
 *  only names a group gets its behaviour from the group — a group created with
 *  different defaults would silently change how the laptop thinks. */
export function relayGroup(group: string, relay: string): GroupShape {
  const url = new URL(relay);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  const endpoint = normalizeOpenAiCompatibleBaseUrl(`${url.protocol}//${url.host}${path}`);
  return group === RELAY_GROUPS.ollama
    ? { provider: 'ollama', endpoint, think: true, reasoning_effort: 'medium' }
    : { provider: 'openai-compatible', endpoint };
}

/** The union of the `remote_start.starter` lists this config already carries, in
 *  first-seen config order, deduped, capped at 4 (the schema ceiling). The
 *  common case: the owner is adding a new desktop model to a machine that already
 *  dials this desktop, so the addresses it already trust are the ones to use. */
export function starterCandidatesFromConfig(config: ForgeConfig): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const model of config.models) {
    if (!model.remote_start) continue;
    for (const url of starterUrlsAsList(model.remote_start.starter)) {
      if (seen.has(url) || list.length >= 4) continue;
      seen.add(url);
      list.push(url);
    }
  }
  return list;
}

/** `remote_start.starter` as an array: the schema accepts one URL or a list. */
function starterUrlsAsList(starter: string | string[]): string[] {
  return Array.isArray(starter) ? starter : [starter];
}

/** The relay address to try for a desktop, from an address that answered the
 *  starter probe: same host, the relay's default port 8797, unless this config
 *  already carries a relay endpoint on that host — then that port is the one
 *  that has to work, because existing cloud entries are dialing it. */
export function relayCandidates(
  config: ForgeConfig,
  answeredStarter: string,
  allCandidates: string[],
  defaultRelayPort = 8797,
): string[] {
  const answeredHost = hostOf(answeredStarter);
  // Config order first: a port this config already dials on this host is a port
  // an existing cloud entry is using, so it is the one most likely to be the
  // relay. The default goes last, so a laptop whose cloud entries point at a
  // non-default relay port is not sent past them by an unrelated probe.
  const ports: number[] = [];
  for (const model of config.models) {
    if (model.remote_start || !model.endpoint) continue;
    const url = new URL(model.endpoint);
    if (hostOf(url.toString()) !== answeredHost) continue;
    if (url.pathname !== '/') continue; // a relay endpoint is a bare origin
    const port = Number(url.port) || defaultRelayPort;
    if (!ports.includes(port)) ports.push(port);
  }
  if (!ports.includes(defaultRelayPort)) ports.push(defaultRelayPort);
  const hosts: string[] = [answeredHost];
  for (const candidate of allCandidates) {
    const host = hostOf(candidate);
    if (host && host !== answeredHost && hosts.length < 4) hosts.push(host);
  }
  const out: string[] = [];
  for (const host of hosts) {
    for (const port of ports) {
      const url = `http://${host}:${port}`;
      if (!out.includes(url)) out.push(url);
    }
  }
  return out;
}

/** The host part of a URL, with the brackets an IPv6 literal carries stripped,
 *  so a starter address and an endpoint can be compared (the same rule
 *  `modelSchema.ts`'s `validateRemoteStartEntry` uses). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/** A tailnet peer Connect can offer: online, not this machine, and with at least
 *  one address to dial. Pure, so a test can feed it `tailscale status --json`
 *  output without ever running Tailscale. */
export interface TailnetPeer {
  name: string;
  addresses: string[];
}

/** Read `tailscale status --json` for the peers a laptop could connect to.
 *  Anything unparsable, or a shape this version of Tailscale does not produce,
 *  comes back as an empty list — the caller then asks for an address instead of
 *  pretending to know the tailnet. Self and offline peers are left out, and
 *  IPv6 link-local addresses are not offered, because `tailscale serve` forwards
 *  the tailnet IPv4 the peer's `tailscaleIPs` carries first. */
export function parseTailnetPeers(json: string): TailnetPeer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return [];
  }
  const peers = (parsed as { Peer?: unknown[] })?.Peer;
  if (!Array.isArray(peers)) return [];
  const out: TailnetPeer[] = [];
  for (const raw of peers) {
    const peer = raw as Record<string, unknown>;
    if (peer?.Self === true) continue;
    if (peer?.Online !== true) continue;
    const name = typeof peer.NodeName === 'string' ? peer.NodeName : '';
    const addresses = Array.isArray(peer.TailscaleIPs)
      ? peer.TailscaleIPs.filter(
          (value): value is string => typeof value === 'string' && /^\d+(\.\d+){3}$/.test(value), // IPv4 only
        )
      : [];
    if (!name || !addresses.length) continue;
    out.push({ name: name.split('.')[0] ?? name, addresses });
  }
  return out;
}

/** Turn what the user typed or what a peer offered into a starter address.
 *  `100.64.0.10`, `100.64.0.10:8798` and `http://100.64.0.10:8798`
 *  all mean the same thing here; a name is refused with the schema's own message,
 *  because the listener's Host check would reject it on every later request. */
export function parseStarterAddress(
  input: string,
  defaultPort = 8798,
): { url: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'An address is required.' };
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'remote_start.starter must be an http:// URL with an IP host' };
  }
  if (url.protocol !== 'http:') {
    return { error: 'remote_start.starter must be an http:// URL with an IP host' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // `net.isIP` is the same check `modelSchema.ts` uses for `remote_start.starter`,
  // so a name that would pass a loose test here is refused at config load too.
  if (net.isIP(host) === 0) {
    return {
      error:
        'remote_start.starter must be an http:// URL with an IP host: a name is refused by the ' +
        "desktop's own anti-rebinding check, so it would fail every request.",
    };
  }
  const port = url.port ? Number(url.port) : defaultPort;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { error: `port ${url.port} is not a valid TCP port.` };
  }
  return { url: `http://${host}:${port}` };
}

/** The message when nothing answered: every address named with its reason, then
 *  the two things that could be wrong. `allStarterFailedMessage` owns the first
 *  half so a laptop reading this sees the same wording it sees on a failed
 *  prompt; the second half is what the import plan's "Errors" section adds. */
export function noDesktopMessage(failures: Array<{ url: string; reason: string }>): string {
  return (
    `${failures.map((f) => `${f.url} (${f.reason})`).join('; ')}. ` +
    'Is a Forge window open on the desktop with model_starter.enabled: true, and is ' +
    'Tailscale up on both machines? Run "Forge: Check connection" on this laptop to ' +
    'find which link is broken.'
  );
}

/** The result message, in the owner's words: what was added, what was already
 *  there, what the desktop refuses and why. Every number comes from the plan, so
 *  the message cannot claim a write that did not happen. */
export function describeConnectResult(
  plan: ConnectPlan,
  counts: { desktopModels: number; cloudModels: number },
): string {
  const parts: string[] = [];
  if (plan.entries.length) {
    const desktop = counts.desktopModels;
    const cloud = counts.cloudModels;
    const added = [
      desktop ? `${desktop} desktop ${desktop === 1 ? 'model' : 'models'}` : '',
      cloud ? `${cloud} cloud ${cloud === 1 ? 'model' : 'models'}` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    parts.push(`added ${added} to config.yaml`);
    const created = Object.keys(plan.groups);
    if (created.length) parts.push(`created the ${created.join(' and ')} group(s)`);
  }
  if (plan.alreadyThere.length) {
    parts.push(
      `${plan.alreadyThere.length} ${plan.alreadyThere.length === 1 ? 'was' : 'were'} already there and left untouched`,
    );
  }
  if (plan.refused.length) {
    parts.push(
      `${plan.refused.length} ${plan.refused.length === 1 ? 'model' : 'models'} the desktop refuses: ${plan.refused
        .map((row) => `${row.name} (${row.reason})`)
        .join(', ')}`,
    );
  }
  if (plan.notAdded.length) {
    parts.push(
      `${plan.notAdded.length} ${plan.notAdded.length === 1 ? 'model was' : 'models were'} not added: ${plan.notAdded[0]!.why}`,
    );
  }
  if (!parts.length)
    return 'Nothing to add: the desktop lists no model this laptop does not already have.';
  return `Forge ${parts.join('; ')}. The laptop will ask the desktop to load a model when it needs one.`;
}
