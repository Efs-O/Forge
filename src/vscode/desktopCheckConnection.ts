/**
 * `Forge: Check connection` — the laptop's walk down its own path to the
 * desktop (docs/plans/V1_FINISH_PLAN.md lane 3 phase 3.4, acceptance criterion 8).
 *
 * The command exists because the failure it replaces was guesswork: a laptop
 * that cannot reach its desktop gets one message, "not reachable", and has five
 * things it could be — Tailscale not running on the laptop, the desktop not
 * online in Tailscale, the starter not answering (no Forge window open there, or
 * sharing off), the relay not answering, and one named model the desktop refuses
 * for its own reason. This walks the links in that order and says which one is
 * broken, in the words the owner can act on, then stops: a laptop whose Tailscale
 * is down learns nothing more from probing the desktop, and every link after the
 * first broken one is a round trip that would fail for the same reason again.
 *
 * The rules, and what the tests pin:
 *
 * - **No second probe implementation.** Which address to dial is
 *   `RemoteStarterRoute.chooseStarter`'s decision — its 2.5 s `GET /models`
 *   probe, its "200 without a `models` list is not a Forge starter" rule and its
 *   never-probe-the-last-address rule. Check connection asks it and reports what
 *   it got: a second definition of "the desktop answered" would drift from it.
 * - **It starts nothing.** Every read is `GET /models` or `GET /v1/models`: a
 *   check that answered "yes, everything works" by loading a model would have
 *   cost the owner a GPU spin-up to learn something the desktop had already
 *   said with `remote: true`. The fifth link is therefore the desktop's own
 *   refusal for a named model — the reason its `/models` reports, which is the
 *   reason its `POST /ensure` would have given — not a real ensure.
 * - **Every wait is bounded, and one abort cancels the lot.** The Tailscale read
 *   gets its 4 s, the probes their 2.5 s each, the starter read its 10 s and the
 *   relay read the 5 s `Connect to my desktop` already gives it (both owned by
 *   `firstAnsweringRelay`, which this check calls rather than reimplementing),
 *   and `registerDesktopCheckConnectionCommands` pushes an abort into
 *   `context.subscriptions` so a window that closes or deactivates mid-check does
 *   not leave requests running against a desktop nobody is asking any more.
 * - **Nothing is written, and nothing is secret.** Check connection reads the
 *   config and the tailnet; it never touches `config.yaml`, never reads
 *   SecretStorage and never runs a `tailscale` command that changes anything.
 *   `serve status` is Share's, not this one's: the starter's own answer already
 *   says whether its port is reachable, and a check that also read the tailnet
 *   configuration would report a share as "fine" while the ACL still refused.
 */

import * as vscode from 'vscode';
import { chooseStarter, allStarterFailedMessage } from '../llm/RemoteStarterRoute';
import { StarterUnreachableError, listStarterModels } from '../llm/RemoteStarterHttp';
import type { ForgeConfig } from '../config/types';
import { getLogger } from '../util/logger';
import { DESKTOP_CHECK_COMMAND, errText, firstAnsweringRelay } from './desktopConnect';
import { starterCandidatesFromConfig } from './desktopConnectPlan';
import { mediaCheckLine } from './desktopConnectMedia';
import { readTailscaleStatus, isTailnetHost, hostOfUrl } from './desktopCheckTailscale';

const log = getLogger();

/** `GET /models` for the check: the same 10 s Connect uses, because this is the
 *  same read against the same machine and the owner is waiting for an answer.
 *  The relay read needs no constant here: it is `firstAnsweringRelay`'s 5 s, the
 *  one Connect already uses, owned by the walker this check now calls. */
const STARTER_READ_TIMEOUT_MS = 10_000;

export interface DesktopCheckDeps {
  getConfig(): ForgeConfig;
  /** Injected so no test runs `tailscale` (the lane rule). */
  runTailscale?: (args: string[], signal?: AbortSignal) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** The relay port to try last. 8797 is the schema default; a test injects its
   *  own because this machine may already be the desktop and hold that port. A
   *  port this config already dials still comes first — `relayCandidates` puts it
   *  there — so this is only the fallback. */
  relayPort?: number;
}

/** Register the laptop's check. Called from `workspaceBootstrap.ts`, where the
 *  config and its path are already in hand and the other two laptop commands are
 *  registered too. The abort in `context.subscriptions` is what cancels a check
 *  whose window closed; every individual read also has its own deadline, so
 *  nothing here can wait for a machine that is not there. */
export function registerDesktopCheckConnectionCommands(
  context: vscode.ExtensionContext,
  deps: DesktopCheckDeps,
): void {
  const controller = new AbortController();
  context.subscriptions.push({ dispose: () => controller.abort() });
  context.subscriptions.push(
    vscode.commands.registerCommand(DESKTOP_CHECK_COMMAND, async () => {
      const message = await runCheck(deps, controller.signal);
      // A palette command's return value goes nowhere, so the walk is shown here;
      // returning it only (until 0.17.191) left the owner with no answer at all.
      // Modal, because the message spans lines and is meant to be read and copied.
      if (!controller.signal.aborted) {
        void vscode.window.showInformationMessage(message, { modal: true });
      }
      return message;
    }),
  );
}

/** One line of the walk: the link, whether it answered, and what was found. The
 *  label is what the message names, so the owner does not have to work out which
 *  step a sentence was about. */
interface CheckLine {
  label: string;
  ok: boolean;
  text: string;
}

/** The whole walk. Returns the message; never throws, because a palette command
 *  that rejects tells the owner nothing about the path they were asking about. */
export async function runCheck(deps: DesktopCheckDeps, signal: AbortSignal): Promise<string> {
  try {
    const config = deps.getConfig();
    const fetchImpl = deps.fetchImpl ?? fetch;
    const lines: CheckLine[] = [];
    const add = (label: string, ok: boolean, text: string): void => {
      lines.push({ label, ok, text });
      log.info(`[Check] ${label}: ${ok ? 'ok' : 'broken'} — ${text}`);
    };

    const candidates = starterCandidatesFromConfig(config);
    if (!candidates.length) {
      // Not a broken link in the chain: there is no path to walk yet, and every
      // other line would be a probe against an address this laptop does not know.
      add(
        'Config',
        false,
        'this laptop lists no models that come from another computer, so there is no path to ' +
          'check. Run Forge: Connect to my desktop first.',
      );
      return format(headline(lines), lines);
    }

    // ── link 1: is Tailscale up on THIS computer? ────────────────────────────
    const status = await readTailscaleStatus(deps, signal);
    const lanAddresses = candidates
      .map((url) => ({ url, host: hostOfUrl(url) }))
      .filter((entry) => !isTailnetHost(entry.host))
      .map((entry) => entry.url);
    if (status.failure || (status.state !== null && status.state.toLowerCase() !== 'running')) {
      const text = status.failure
        ? /not found/.test(status.failure)
          ? `Tailscale is not installed on this computer, or its CLI is not where Forge looks (${status.failure}).`
          : `Tailscale is not running on this computer: its CLI did not answer (${status.failure}).`
        : `Tailscale here is ${status.state?.toLowerCase()}, not connected` +
          `${status.tailnet ? ` (tailnet ${status.tailnet})` : ''}.` +
          (status.state?.toLowerCase().includes('login')
            ? ' Sign in with Tailscale on this computer.'
            : ' Start Tailscale on this computer.');
      // A home laptop can still reach its desktop through the LAN forwarder with
      // no Tailscale at all, so this link is reported as broken and the walk goes
      // on — one line, so the message cannot read as "this link is fine after
      // all" when it is the link the owner has to fix. The difference between
      // "you are broken" and "this one thing is off and your other route still
      // works" is carried by whether the walk stops, not by a second line.
      add(
        'Tailscale here',
        false,
        lanAddresses.length
          ? `${text} Continuing anyway: this config also dials a LAN address ` +
              `(${lanAddresses.join(', ')}), which does not need Tailscale.`
          : text,
      );
      if (!lanAddresses.length) return format(headline(lines), lines);
    } else {
      add(
        'Tailscale here',
        true,
        `running${status.tailnet ? ` on tailnet ${status.tailnet}` : ''}, and this computer has an address for it.`,
      );
    }

    // ── link 2: does this computer's Tailscale see the desktop? ──────────────
    const tailnetHosts = [...new Set(candidates.map(hostOfUrl).filter(isTailnetHost))];
    if (!tailnetHosts.length) {
      add(
        'Desktop in Tailscale',
        true,
        `skipped: every configured address (${candidates.join(', ')}) is a LAN address, so Tailscale does not have to see the desktop for this route.`,
      );
    } else {
      const online = status.peers.filter((peer) => peer.online);
      const found = online.find((peer) =>
        tailnetHosts.some((host) => peer.addresses.includes(host)),
      );
      if (found) {
        add(
          'Desktop in Tailscale',
          true,
          `${found.name} (${found.addresses.join(', ')}) is online on this tailnet.`,
        );
      } else {
        const offline = status.peers.find((peer) =>
          tailnetHosts.some((host) => peer.addresses.includes(host)),
        );
        const text = offline
          ? `the desktop ${offline.name} is on this tailnet but is not online now — it is asleep, or Tailscale is stopped on it.`
          : `no machine with the address this laptop dials (${tailnetHosts.join(', ')}) is on this tailnet. Is the desktop powered on, is Tailscale up there, and is it the same tailnet as this computer's?`;
        add('Desktop in Tailscale', false, text);
        // Probing an address Tailscale does not have cannot succeed, so the walk
        // stops here rather than spending 2.5 s per address on it.
        return format(headline(lines), lines);
      }
    }

    // ── link 3: does the model starter answer? ───────────────────────────────
    const choice = await chooseStarter(candidates, fetchImpl, signal);
    let rows: Array<Record<string, unknown>> = [];
    let sharedPort: number | null = null;
    try {
      const listed = await listStarterModels(
        fetchImpl,
        choice.starter,
        STARTER_READ_TIMEOUT_MS,
        signal,
      );
      rows = listed.models;
      sharedPort = listed.sharedPort;
      add(
        'Model starter',
        true,
        `${choice.starter} answered — model_starter is on there. ` +
          (sharedPort === null
            ? 'It does not report a shared port, so it is a desktop build older than the pass-through: run Forge: Share this computer on the desktop to update it.'
            : `Model traffic for this laptop arrives on port ${sharedPort}.`) +
          (choice.failures.length
            ? ` ${choice.failures.length} earlier ${choice.failures.length === 1 ? 'address' : 'addresses'} did not answer: ${choice.failures.map((f) => `${f.url} (${f.reason})`).join('; ')}.`
            : ''),
      );
    } catch (error) {
      const text =
        error instanceof StarterUnreachableError
          ? allStarterFailedMessage([
              ...choice.failures,
              { url: choice.starter, reason: error.reason },
              ...candidates.slice(candidates.indexOf(choice.starter) + 1).map((url) => ({
                url,
                reason: 'not tried, this address was asked first',
              })),
            ])
          : `${choice.starter}: ${errText(error)}`;
      add('Model starter', false, text);
      return format(headline(lines), lines);
    }

    // ── link 4: does the cloud relay answer? ─────────────────────────────────
    // A laptop with no cloud entry pointing at the desktop has no relay path, so
    // a silent relay is not its problem and the walk says so instead of probing.
    const cloudEntries = config.models.filter(
      (model) => !model.remote_start && model.provider === 'openai-compatible' && model.endpoint,
    );
    // A laptop that asked for desktop-rendered images needs the relay even with no cloud model.
    const wantsMedia = config.remote_media?.enabled === true;
    let mediaRelayUrl: string | null = null;
    if (!cloudEntries.length && !wantsMedia) {
      add(
        'Cloud relay',
        true,
        'skipped: this laptop lists no cloud models that come through the desktop, so the relay is not part of its path.',
      );
    } else {
      // The same walker `Connect to my desktop` uses, so "the relay answered"
      // cannot mean two things in one repo: it owns the address order
      // (`relayCandidates`), the 5 s deadline and the per-address reasons this
      // line prints, and it is what a later change to any of those reaches.
      const relay = await firstAnsweringRelay(
        { relayPort: deps.relayPort },
        fetchImpl,
        config,
        choice.starter,
        candidates,
        signal,
      );
      if (relay.ok) {
        mediaRelayUrl = relay.url;
        add(
          'Cloud relay',
          true,
          `${relay.url} answered — cloud_relay is on there and allows ${relay.rows.length} ${
            relay.rows.length === 1 ? 'model' : 'models'
          }.`,
        );
      } else {
        // Soft, on purpose: `Connect to my desktop` treats a silent relay as
        // "the cloud models were not read" rather than a failed run, so a check
        // that stopped here would report a laptop as broken when its desktop
        // models work perfectly. The walk goes on to the models link and this
        // line says which half is affected.
        add(
          'Cloud relay',
          false,
          `nothing answered on any relay address this laptop could reach: ` +
            `${relay.tried.map((row) => `${row.url} (${row.reason})`).join('; ')}. ` +
            'Is cloud_relay.enabled: true on the desktop, and is its port shared? Cloud models ' +
            'will not work from this laptop until one of those is fixed; the desktop\u2019s own ' +
            'models are not affected, so this is the first link broken for cloud models only.',
        );
      }
    }

    // ── link 4b: what can that desktop render? (`cloud_relay.media` on it.) ──
    if (mediaRelayUrl) {
      const media = await mediaCheckLine(fetchImpl, mediaRelayUrl, wantsMedia, signal);
      add(media.label, media.ok, media.text);
    }

    // ── link 5: does the desktop serve the models this laptop dials? ─────────
    const byName = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      if (typeof row.name === 'string') byName.set(row.name, row);
    }
    const dialed = config.models.filter((model) => model.remote_start);
    const problems: string[] = [];
    const served: string[] = [];
    for (const model of dialed) {
      const name = model.remote_start?.model || model.name;
      const row = byName.get(name);
      if (!row) {
        problems.push(
          `${model.name}: the desktop does not list it at all — the two machines must spell a name the same way, so check the name on the desktop or run Forge: Share this computer there and Connect again`,
        );
        continue;
      }
      if (row.remote !== true) {
        problems.push(`${model.name}: the desktop refuses it (${plainReason(row.reason)})`);
        continue;
      }
      served.push(model.name);
    }
    if (problems.length) {
      add('Models', false, problems.join('; '));
    } else {
      add(
        'Models',
        true,
        `all ${served.length} ${served.length === 1 ? 'model' : 'models'} this laptop dials are servable on the desktop (${served.join(', ')}). Nothing was started to check this: the desktop said so with its own model list.`,
      );
    }

    return format(headline(lines), lines);
  } catch (error) {
    // A cancelled walk is not a broken path: say what happened rather than let
    // the last read's failure stand as a diagnosis of the desktop.
    if (signal.aborted) {
      log.info('[Check] cancelled: this window closed while the walk was running');
      return 'The check was cancelled: this window closed while it was walking the path.';
    }
    log.warn(`[Check] failed: ${errText(error)}`);
    return `The check did not complete: ${errText(error)}`;
  }
}

/** The desktop's refusal, in the owner's words. The codes come from
 *  `remoteServability` on the desktop, so this is the desktop's reason, translated
 *  rather than invented — and it is the same reason its `POST /ensure` would have
 *  returned for that model. */
function plainReason(reason: unknown): string {
  switch (reason) {
    case 'not_local':
      return 'it is not a model this desktop can start for a laptop — a cloud model, or a server somebody else started';
    case 'ollama_not_shared':
      return 'it is an Ollama model, and the desktop does not serve Ollama models to laptops';
    case 'cli_agent':
      return 'it is a Claude Code or Codex CLI agent, which cannot run on another computer';
    case 'port_not_shared':
      return 'it has no port to reach, so neither the tailnet nor the pass-through can serve it';
    case 'service_port':
      return 'it points at a port Forge uses for itself, which is never a model';
    default:
      return typeof reason === 'string' ? reason : 'the desktop gave no reason';
  }
}

/** The headline, naming the first broken link — the answer to the question the
 *  owner asked, put where they cannot miss it. */
function headline(lines: CheckLine[]): string {
  const broken = lines.find((line) => !line.ok);
  if (!broken) return 'Every link answered:';
  return `Forge checked this laptop's path to your desktop. The first link that is broken is: ${broken.label}.`;
}

/** What to do about the link that broke, in one line. A table rather than a
 *  sentence, because "Tailscale is down here" and "the desktop refuses this
 *  model" are not the same action and the owner should not have to guess. */
function adviceFor(label: string): string {
  switch (label) {
    case 'Config':
      return 'Run Forge: Connect to my desktop to add the desktop\u2019s models to this config, then check again.';
    case 'Tailscale here':
      return 'Start Tailscale on this laptop and sign in, or reach the desktop over your home network, which needs no Tailscale at all.';
    case 'Desktop in Tailscale':
      return 'Wake the desktop or start Tailscale on it. If it is on a different tailnet, this laptop has to be on that one too.';
    case 'Model starter':
      return 'Open a Forge window on the desktop and run Forge: Share this computer there — it turns both switches on and shares exactly the two ports this path needs.';
    case 'Cloud relay':
      return 'Your desktop models will work from this laptop; the cloud ones will not. Run Forge: Share this computer on the desktop to turn both on at once.';
    case 'Models':
      return 'Fix the name on the desktop, or run Forge: Share this computer there and Forge: Connect to my desktop here, which writes the names the desktop actually reports.';
    default:
      return 'Run Forge: Share this computer on the desktop.';
  }
}

/** The message: the headline, then every link in order, then what to do next.
 *  A line marked `broken` is the one the headline names; the lines after it are
 *  shown only when the walk went on past them (a LAN route still open, or a
 *  broken relay next to a working starter), because "which link is broken" and
 *  "what else is fine" are two different questions and the owner needs both. */
function format(lead: string, lines: CheckLine[]): string {
  const body = lines.map((line) => `  • ${line.label}: ${line.text}`).join('\n');
  const broken = lines.find((line) => !line.ok);
  const others = lines.filter((line) => !line.ok && line !== broken);
  const next = broken
    ? adviceFor(broken.label) +
      (others.length
        ? ` Further down the path these are broken too: ${others.map((line) => line.label).join(', ')}.`
        : '')
    : 'Nothing to fix: this laptop can reach everything the desktop offers. The first model you use will be loaded by the desktop when you ask it.';
  return `${lead}\n${body}\n\n${next}`;
}
