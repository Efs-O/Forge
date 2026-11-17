/**
 * "Forge: Connect to my desktop" — the laptop command, and the notice that keeps
 * a laptop up to date with the models its desktop offers
 * (docs/plans/V1_FINISH_PLAN.md lane 3 phase 3.2).
 *
 * This file is the IO half; `desktopConnectPlan.ts` holds every decision
 * (which entry to write, which name to leave alone, which group to create) so
 * the tests can drive those decisions without a laptop, a desktop or Tailscale.
 * What lives here is only: which address answers, what the desktop says, and one
 * write to `config.yaml`.
 *
 * Two invariants the tests pin:
 *
 * - **It writes, it never runs.** Every desktop read is `GET /models` or
 *   `GET /v1/models`. No `POST /ensure`, no `/release`, no `/unload`: Connect
 *   must work against a sleeping desktop, and a config edit that quietly started
 *   the desktop's GPU work would be the defect `IMPORT_DESKTOP_MODELS_PLAN.md`
 *   made a CI test out of.
 * - **No key, ever.** Connect reads nothing from SecretStorage and writes no
 *   `api_key_secret`: the cloud entries it writes are a name plus a group, and
 *   the desktop's relay resolves its own tokens when the laptop uses them.
 *
 * Tailscale is used for one thing only, and only when this laptop has no
 * `remote_start` entries yet: `tailscale status --json`, read, to offer the
 * online machines by name. Connect never runs `tailscale serve`, never touches
 * the ACL, Tailnet Lock or sign-in, and there is no pairing code — the starter
 * has no token by design, so nothing secret is exchanged. The CLI is injected,
 * so no test ever runs it.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as YAML from 'yaml';
import { updateConfigFile, addModel, setNestedField, deepEqual } from '../config/ConfigWriter';
import { chooseStarter } from '../llm/RemoteStarterRoute';
import {
  listRelayModels,
  listStarterModels,
  StarterUnreachableError,
  failureReasonOf,
  type RelayModelRow,
} from '../llm/RemoteStarterHttp';
import { getLogger } from '../util/logger';
import type { ForgeConfig } from '../config/types';
import {
  describeConnectResult,
  noDesktopMessage,
  parseStarterAddress,
  parseTailnetPeers,
  planConnect,
  relayCandidates,
  starterCandidatesFromConfig,
  type ConnectPlan,
  type ConnectTargets,
  type DesktopModelRow,
  type TailnetPeer,
} from './desktopConnectPlan';
import { runTailscaleCli, TAILSCALE_READ_TIMEOUT_MS } from './tailscaleCli';
import {
  REMOTE_MEDIA_RELOAD_NOTE,
  mediaConnectAdditions,
  probeRemoteMedia,
} from './desktopConnectMedia';

const log = getLogger();

/** The command names, contributed in `package.json` and registered from
 *  `workspaceBootstrap.ts` — `src/extension.ts` is at its 500-line cap, so the
 *  registration lives here and the call is one line in a module that already
 *  owns workspace activation work. */
export const DESKTOP_CONNECT_COMMAND = 'forge.connectDesktop';
/** Phase 3.4 adds this one; the name is declared here so the two laptop commands
 *  are contributed and registered from the same place. */
export const DESKTOP_CHECK_COMMAND = 'forge.checkConnection';

/** `GET /models` from a machine we hope is a Forge starter: 10 s is long enough
 *  for a tailnet round trip plus a cold `tailscale` hole punch and short enough
 *  that a laptop in a café is not held up before it reports. */
const LIST_TIMEOUT_MS = 10_000;
/** The relay read is the same shape, and a failure there is not fatal: the
 *  desktop models are still written and the cloud half is reported as unread. */
const RELAY_TIMEOUT_MS = 5_000;
export interface DesktopConnectDeps {
  getConfig(): ForgeConfig;
  /** The config file Connect writes into — `forge.configFile` is machine-scoped,
   *  so this is the laptop's own file in a laptop window. */
  getConfigPath(): string;
  /** Injected so a test never runs the real CLI: `docs/plans/V1_FINISH_PLAN.md`
   *  lane 3 says `tailscale` is never run in tests. */
  runTailscale?: (args: string[], signal?: AbortSignal) => Promise<string>;
  /** The starter port to write for a desktop discovered from Tailscale: 8798 is
   *  the schema default and the port `tailscale serve` forwards, and a test
   *  cannot bind it (this machine may already be the desktop), so it injects its
   *  own. It is never guessed from the peer: a peer's address is an address, not
   *  a port. */
  starterPort?: number;
  /** The cloud relay port to probe, same reason: 8797 is the default, and a test
   *  cannot claim it either. A port this config already dials still comes first.
   *  `CONNECT_RELAY_PORT`-style config is not read here on purpose: the relay port
   *  is the desktop's setting, not the laptop's. */
  relayPort?: number;
  fetchImpl?: typeof fetch;
}

/** The picker's last item: typing an address is how a laptop connects to a
 *  desktop Tailscale does not list (a LAN forwarder, a machine on another tailnet). */
const TYPED_ITEM_LABEL = 'Type an address…';

/** Register the laptop commands. Called from `workspaceBootstrap.ts`, which is
 *  where the config and its path are already in hand. */
export function registerDesktopConnectCommands(
  context: vscode.ExtensionContext,
  deps: DesktopConnectDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(DESKTOP_CONNECT_COMMAND, async () => {
      try {
        const message = await runConnect(deps);
        if (message) void vscode.window.showInformationMessage(`Forge: ${message}`);
      } catch (error) {
        // A rejected promise out of a palette command is a silent failure: the
        // owner clicked, Forge said nothing, and the extension host swallowed it.
        // The two ways this run can throw are a `config.yaml` that no longer
        // parses and a missing Tailscale CLI, and each has a fix the owner can
        // act on, so the reason is shown rather than logged.
        void vscode.window.showErrorMessage(`Forge: ${errText(error)}`);
      }
    }),
  );
}

/**
 * The whole run. Returns the message to show (empty when the user cancelled),
 * and is also what the keeping-up notice calls after "Add them" is clicked —
 * which is why it takes an optional name filter rather than a second code path.
 */
export async function runConnect(
  deps: DesktopConnectDeps,
  options: { onlyNames?: Set<string> } = {},
): Promise<string> {
  const config = deps.getConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  let candidates = starterCandidatesFromConfig(config);
  if (!candidates.length) {
    const picked = await pickDesktop(deps);
    if (!picked) return '';
    candidates = [picked];
  }
  // Which address to ask is `RemoteStarterRoute`'s job, not Connect's: it owns
  // the probe order, the 2.5 s deadline and the "200 without a models list is
  // not a Forge starter" rule, so Connect cannot invent a second definition of
  // "the desktop answered".
  const choice = await chooseStarter(candidates, fetchImpl, undefined);
  let listed: Awaited<ReturnType<typeof listStarterModels>>;
  try {
    listed = await listStarterModels(fetchImpl, choice.starter, LIST_TIMEOUT_MS, undefined);
  } catch (error) {
    if (error instanceof StarterUnreachableError) {
      return noDesktopMessage([
        ...choice.failures,
        { url: choice.starter, reason: error.reason },
        ...candidates.slice(candidates.indexOf(choice.starter) + 1).map((url) => ({
          url,
          reason: 'not tried, this address was asked first',
        })),
      ]);
    }
    // A 403/422/500 from the desktop is an answer with a fix in it; show it as
    // written rather than turning it into "not reachable".
    return error instanceof Error ? error.message : String(error);
  }
  const relay = await firstAnsweringRelay(deps, fetchImpl, config, choice.starter, candidates);
  // One more read of the relay this run just reached, for the media switch
  // (`desktopConnectMedia.ts`): a desktop that renders nothing for laptops is
  // the common answer, and it is a sentence, not a failure.
  const media = relay.ok ? await probeRemoteMedia(fetchImpl, relay.url) : undefined;
  const targets: ConnectTargets = {
    starters: candidates.slice(0, 4),
    // The desktop's own shared port, exactly as it reported it. `null` is not
    // filled in with the starter's port on purpose: an old desktop would then get
    // entries that 404 on every request, and the message below says what to do
    // instead of writing a config that looks right and fails later.
    sharedPort: listed.sharedPort,
    relay: relay.ok ? relay.url : null,
    relayFailure: relay.ok ? null : relay.reason,
  };
  const rows = listed.models
    .map(toDesktopRow)
    .filter((row): row is DesktopModelRow => row !== null)
    .filter((row) => !options.onlyNames || options.onlyNames.has(row.name));
  const plan = planConnect(rows, relay.ok ? relay.rows : [], config, targets);
  if (relay.ok && media) mediaConnectAdditions(plan, media, relay.url, config);
  // What the owner reads when the desktop renders nothing: the desktop's own
  // sentence. Nothing when it does render — that is in the added-clause above.
  const mediaNote = media && !plan.remoteMedia ? ` ${media.note}` : '';
  const counts = {
    desktopModels: plan.entries.filter((entry) => !entry.group).length,
    cloudModels: plan.entries.filter((entry) => entry.group !== undefined).length,
  };
  if (!plan.entries.length && !Object.keys(plan.groups).length && !plan.remoteMedia) {
    const message = describeConnectResult(plan, counts);
    if (plan.notes.length) log.info(`[Connect] ${plan.notes.join(' ')}`);
    return `${message}${mediaNote}`;
  }
  const wrote = applyConnectPlan(deps.getConfigPath(), plan);
  if (!wrote) {
    return (
      'The write was refused and config.yaml was left exactly as it was: an entry that ' +
      'was already there came out of the write changed. Compare the file with its ' +
      '.bak, or delete the entry and run Connect again.'
    );
  }
  const message = describeConnectResult(plan, counts);
  log.info(
    `[Connect] ${hostLabel(choice.starter)} -> ${message} ` +
      `${plan.notes.length ? `Notes: ${plan.notes.join(' ')}` : ''}`,
  );
  // The reload sentence, and only when this run actually turned the switch on:
  // `registerAllTools` chooses local versus desktop image tools once per
  // activation, so this window's `generate_image` is still the local one.
  return (
    `${message}${plan.notes.length ? ` Notes: ${plan.notes.join(' ')}` : ''}${mediaNote}` +
    `${plan.remoteMedia ? REMOTE_MEDIA_RELOAD_NOTE : ''}`
  );
}

/** One `GET /models` row, kept as the shape the desktop sent: the plan module
 *  reads each field defensively, so a desktop build that renames or drops one
 *  costs the laptop a note rather than a crash. `loaded` and `leasedBy` are not
 *  copied at all — an entry must not depend on what was loaded at read time. */
export function toDesktopRow(value: unknown): DesktopModelRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== 'string' || !row.name.trim()) return null;
  return {
    name: row.name,
    display_name: row.display_name,
    remote: row.remote === true,
    reason: row.reason,
    context: row.context,
    capabilities: row.capabilities,
    model: row.model,
    token_count: row.token_count,
    reasoning_effort: row.reasoning_effort,
  };
}

/**
 * The relay read, tried against every address this laptop could reach the
 * desktop on: the host that answered the starter first, then the others, each
 * with the relay port this config already uses if it differs from the default.
 * The first that answers supplies the allowlist. None answering is not an error
 * — the desktop models are still written — but the reason has to travel to the
 * message, because "the desktop has no cloud models" and "its relay is off"
 * look identical in a short list and have different fixes.
 *
 * Exported because phase 3.4's "Check connection" walks this same link, and two
 * definitions of "the relay answered" in one repo drift: the check calls this
 * instead of writing its own loop, which is why the per-address reasons its
 * message prints come back as `tried` rather than only the last one. `signal` is
 * the caller's abort, and a cancelled read PROPAGATES rather than being recorded
 * as a relay that refused — `RemoteStarterRoute`'s probe follows the same rule
 * for the same reason: a window that closed is not a diagnosis of the desktop.
 */
export async function firstAnsweringRelay(
  deps: { relayPort?: number | undefined },
  fetchImpl: typeof fetch,
  config: ForgeConfig,
  answeredStarter: string,
  candidates: string[],
  signal?: AbortSignal | undefined,
): Promise<
  | { ok: true; url: string; rows: RelayModelRow[] }
  | { ok: false; reason: string; tried: Array<{ url: string; reason: string }> }
> {
  const tried: Array<{ url: string; reason: string }> = [];
  for (const url of relayCandidates(config, answeredStarter, candidates, deps.relayPort ?? 8797)) {
    try {
      const rows = await listRelayModels(fetchImpl, url, RELAY_TIMEOUT_MS, signal);
      return { ok: true, url, rows };
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = failureReasonOf(error);
      tried.push({ url, reason });
      log.info(`[Connect] relay ${url}: ${reason}`);
    }
  }
  return {
    ok: false,
    reason: tried.length ? tried[tried.length - 1]!.reason : 'no relay answered',
    tried,
  };
}

/** The host part of an answer, for the log line. */
function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Which desktop to ask, when this laptop has no `remote_start` entries to copy:
 * the online machines Tailscale reports, by name, with their tailnet address as
 * the description, and "Type an address…" as the last item so a LAN forwarder or
 * a machine on another tailnet is still reachable. One picker, as the plan says:
 * no pairing code, because nothing secret is exchanged with a token-less starter.
 *
 * Exported because phase 3.4's "Check connection" asks the same question when
 * this laptop lists no desktop entries, and must not grow a second picker that
 * could offer a different list from the one Connect writes entries for.
 */
export async function pickDesktop(deps: DesktopConnectDeps): Promise<string | undefined> {
  const run = deps.runTailscale ?? defaultRunTailscale;
  const starterPort = deps.starterPort ?? 8798;
  let peers: TailnetPeer[] = [];
  try {
    peers = parseTailnetPeers(await run(['status', '--json'], undefined));
  } catch (error) {
    log.info(`[Connect] tailscale status failed: ${failureReasonOf(error)}`);
  }
  const items: vscode.QuickPickItem[] = peers.map((peer) => ({
    label: peer.name,
    description: peer.addresses[0],
    detail: 'Connect to this machine',
  }));
  items.push({
    label: TYPED_ITEM_LABEL,
    description: `http://<ip>:${starterPort} — LAN forwarder, or a machine Tailscale does not list`,
  });
  const prompt = peers.length
    ? 'Which desktop computer has the Forge models you want?'
    : `No online Tailscale peers: type the desktop address (http://<ip>:${starterPort}).`;
  const picked = await vscode.window.showQuickPick(items, { prompt });
  const typed =
    picked?.label === TYPED_ITEM_LABEL
      ? await vscode.window.showInputBox({
          prompt: 'The desktop model starter address',
          value: `http://192.168.1.70:${starterPort}`,
          ignoreFocusOut: true,
        })
      : picked
        ? `http://${picked.description ?? ''}:${starterPort}`
        : undefined;
  if (typed === undefined) return undefined;
  const parsed = parseStarterAddress(typed);
  if ('error' in parsed) {
    void vscode.window.showErrorMessage(`Forge: ${parsed.error}`);
    return undefined;
  }
  return parsed.url;
}

/** `tailscale status --json`, read only. The location list, the argv-only
 *  `execFile` and the ENOENT-falls-through-to-the-next-location rule live in
 *  `tailscaleCli.ts`, which the desktop's Share command uses for the same
 *  reasons; what is local to this file is the deadline: 4 s, because the answer
 *  only decides what the picker offers, and a machine where Tailscale is stopped
 *  or hung must cost a fallback to typing rather than a stuck command. */
function defaultRunTailscale(args: string[], signal?: AbortSignal): Promise<string> {
  return runTailscaleCli(args, { timeoutMs: TAILSCALE_READ_TIMEOUT_MS, signal });
}

/**
 * The whole run's writes, in ONE `updateConfigFile` call: groups first (an entry
 * that names a group is only valid once the group exists), then the new entries.
 * The `verify` callback is what makes "an existing entry is never touched"
 * assertible from inside the lock — every entry the file already had must come
 * out deep-equal, or the writer restores the original bytes and Connect reports
 * the refusal rather than a partial edit.
 */
export function applyConnectPlan(configPath: string, plan: ConnectPlan): boolean {
  const before = readEntriesByName(configPath);
  return updateConfigFile(
    configPath,
    (doc) => {
      for (const [name, shape] of Object.entries(plan.groups)) {
        // Re-checked against the live document, because two cloud kinds can want
        // the same group in one run and `setNestedField` would otherwise replace
        // the one it just created.
        if (doc.getIn(['groups', name], true)) continue;
        setNestedField(doc, ['groups', name], shape);
      }
      // The media switch, and only when this config does not already carry one:
      // an owner who turned `remote_media` off by hand stays off until they ask.
      if (plan.remoteMedia && !doc.getIn(['remote_media'], true)) {
        setNestedField(doc, ['remote_media'], plan.remoteMedia);
      }
      for (const entry of plan.entries) addModel(doc, entry);
    },
    () => everyEntryStillIntact(configPath, before),
  );
}

/** The config's model entries by name, as plain JSON, for the before/after
 *  comparison. Unparsable or absent comes back empty, which is what a first run
 *  (no config yet) needs. */
function readEntriesByName(configPath: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const parsed = readConfigJson(configPath);
  for (const entry of parsed) out.set(String(entry.name), entry);
  return out;
}

function readConfigJson(configPath: string): Array<Record<string, unknown>> {
  try {
    if (!fs.existsSync(configPath)) return [];
    const doc = YAML.parseDocument(fs.readFileSync(configPath, 'utf8'));
    const models = doc.toJS()?.models;
    return Array.isArray(models)
      ? models.filter((entry): entry is Record<string, unknown> => {
          return entry !== null && typeof entry === 'object' && !Array.isArray(entry);
        })
      : [];
  } catch (error) {
    log.warn(`[Connect] could not read config.yaml for the before/after check: ${errText(error)}`);
    return [];
  }
}

/** Every entry the file had before the write must still be there, unchanged.
 *  A `false` here makes `updateConfigFile` restore the original bytes, so the
 *  byte-identity guarantee is enforced by the writer and not merely asserted by
 *  a test. */
function everyEntryStillIntact(configPath: string, before: Map<string, unknown>): boolean {
  const after = new Map<string, unknown>();
  for (const entry of readConfigJson(configPath)) after.set(String(entry.name), entry);
  for (const [name, value] of before) {
    if (!after.has(name)) return false;
    if (!deepEqual(after.get(name), value)) return false;
  }
  return true;
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
