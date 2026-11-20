/**
 * What `Forge: Share this computer` and `Forge: Stop sharing this computer`
 * decide (docs/plans/V1_FINISH_PLAN.md lane 3 phase 3.3). Pure on purpose: the
 * two commands differ only in which way they move the same two switches, and
 * every rule that the acceptance criteria pin — the exact commands shown before
 * anything runs, the two config switches in one write, and never naming the
 * control port or the Ollama daemon port — is a rule this module can answer
 * without a tailnet, a Tailscale install or a desktop.
 *
 * The rules, and why they are what they are:
 *
 * - **Only the two ports Forge listens on are shared**: `model_starter.port`
 *   (8798) and `cloud_relay.port` (8797). The control server and the Ollama
 *   daemon are never in a command, never in a note and never in a message,
 *   because a computer that shares its control port has exposed a loopback
 *   admin API to a whole tailnet, and one that shares 11434 has exposed a daemon
 *   that answers any request with any model. The tests assert those two numbers
 *   appear nowhere in what Share says or runs.
 * - **`model_starter.enabled` needs `control_server.enabled`** — the starter
 *   shares the control server's lifecycle state and serialisation chain, and the
 *   schema refuses the pair otherwise. So Share turns that one on too when it is
 *   off, and says so: it is loopback-only and stays unshared.
 * - **A created `model_starter` block gets `shared_ports: [<its own port>]`.**
 *   That field mirrors the ACL by hand, and the only port this command shares is
 *   the starter's own: model ports stay loopback-only and a laptop's model
 *   traffic comes through the pass-through on that port. Listing the model ports
 *   instead would promise a route the tailnet does not have.
 * - **A created `cloud_relay` block needs an allowlist**, and an allowlist of
 *   models that actually need a relay: the keyed cloud models this config knows.
 *   A desktop with none has nothing to share, so the relay stays off rather than
 *   getting an empty block the schema would reject.
 * - **Nothing is run twice and nothing is removed that is not Forge's.** A port
 *   `serve` already forwards is reported, not re-shared — unless it forwards
 *   somewhere else, in which case the command re-points it and the note says so.
 *   `Stop sharing` flips the two switches and turns off only the shares it made
 *   for those two ports; every other share on the machine is left alone — and
 *   named, because on this desktop nine hand-shared model ports (8070,
 *   8080-8083, 8090-8092, 8094) are still forwarded to loopback after either
 *   command, and a run that said nothing about them would read as "this computer
 *   is closed to the tailnet" when it is not.
 * - **The messages after a run, the ACL warning and the hosted-window message
 *   live in `desktopShareText.ts`**: a message is not a decision, and this module
 *   has to be able to say what a run does without knowing how it will be phrased.
 * - **The candidate config is validated before anything changes**: the caller
 *   parses `candidate` with `ForgeConfigSchema` and aborts before running a
 *   `serve` command or writing the file, so a config that would not come back
 *   valid never touches the tailnet.
 * - **The `serve` command text and its status parse live in `tailscaleServe.ts`**,
 *   which owns the argv, the string the owner pastes and `serve status --json`.
 *   This module only decides which ports go into them and which switches the
 *   write moves, so the two files can be tested apart from each other.
 */

import { mergeGroupsIntoModel } from '../config/ConfigResolver';
import { isOllamaCloudModel } from '../llm/ModelRouteClassifier';
import { renderTailscaleCommand, serveShareArgs, serveUnshareArgs } from './tailscaleServe';
import type { ServeStatus } from './tailscaleServe';
import type { ForgeConfig, ModelConfig } from '../config/types';

/** The two ports Forge shares, and the two it never touches. Declared together
 *  so the "never names" rule has a place to say what it means. */
export const DEFAULT_STARTER_PORT = 8798;
export const DEFAULT_RELAY_PORT = 8797;
/** Forge's own control API and the Ollama daemon: never shared, never named. */
const PORTS_NEVER_SHARED = [8799, 11434];

/** One `config.yaml` edit: a path of keys and the scalar or object to put there.
 *  `setNestedField` in `config/ConfigWriter.ts` applies these in one write, so
 *  the comment-preserving guarantee is that module's, not Share's. */
export interface ConfigEdit {
  path: string[];
  value: unknown;
}

/** Everything Share needs to know before it changes anything. */
export interface ShareFacts {
  /** The desktop's parsed config — schema-valid, so its blocks are complete. */
  config: ForgeConfig;
  /** The `tailscale` executable this run will use, as a path or the bare name
   *  when no known install was found. It is in the plan so the commands the
   *  owner sees are the commands Forge runs, one string built in one place. */
  executable: string;
  status: ServeStatus | null;
  /** Why `serve status --json` could not be read, or null when it worked. The
   *  plan treats an unread tailnet as "nothing is shared yet": the commands it
   *  shows are idempotent, so guessing wrong costs a second `serve` that changes
   *  nothing, where guessing the other way would leave a share off. */
  statusFailure: string | null;
}

/** What a run would do. The command shows this text, then does it. */
export interface SharePlan {
  /** `tailscale` argv tails, in the order to run them (no executable). */
  serveArgs: string[][];
  /** The same commands as text, quoted the way the owner would paste them. */
  shownCommands: string[];
  /** The ports this run would change on the tailnet: the two Forge listens on,
   *  and no others. Declared apart from `serveArgs` so the dialog can show them
   *  and the "never names 8799 or 11434" test has something to read without
   *  parsing a command line. */
  ports: number[];
  /** Every TCP port `serve` still forwards that is not one of Forge's own two.
   *  The note names them, and the message after a run repeats them, so neither
   *  can claim the machine is closed to the tailnet when nine ports are still
   *  forwarded to loopback servers. */
  foreignShares: number[];
  configEdits: ConfigEdit[];
  notes: string[];
  /** The config as it would be after every edit, for validation first. */
  candidate: ForgeConfig;
  /** True when neither the file nor the tailnet would change at all. */
  nothingToDo: boolean;
}

/** The names a `cloud_relay` block may list, mirroring what
 *  `validateCloudRelayConfig` accepts, so a block Share creates cannot be the
 *  one thing that makes the config invalid: Ollama cloud models on a loopback
 *  endpoint, and keyed provider models. Group-defined models are merged first,
 *  because that is what the validator sees. */
export function relayAllowlist(config: ForgeConfig): string[] {
  return config.models
    .map((entry) => mergeGroupsIntoModel(config, entry as unknown as ModelConfig))
    .filter((model) => {
      const provider = model.provider ?? '';
      if (provider === 'ollama') {
        const host = endpointHostOf(model.endpoint);
        return (
          isOllamaCloudModel(model) &&
          (host === 'localhost' || host === '127.0.0.1' || host === '::1')
        );
      }
      if (!['openrouter', 'openai', 'openai-compatible'].includes(provider)) return false;
      return Boolean(model.api_key_secret);
    })
    .map((model) => model.name);
}

function endpointHostOf(endpoint: string | undefined): string {
  try {
    return new URL(endpoint ?? '').hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

/** The port each block listens on: its own if it set one, the schema default
 *  otherwise. A block that does not exist still has a default, and that is the
 *  port the tailnet has to forward, so the command is composed from it too. */
export function starterPort(config: ForgeConfig): number {
  return config.model_starter?.port ?? DEFAULT_STARTER_PORT;
}
export function relayPort(config: ForgeConfig): number {
  return config.cloud_relay?.port ?? DEFAULT_RELAY_PORT;
}

/** `Share this computer`: the two switches on, and the two ports forwarded to
 *  the loopback addresses Forge listens on. */
export function planShare(facts: ShareFacts): SharePlan {
  const { config, status, statusFailure } = facts;
  const notes: string[] = [];
  const edits: ConfigEdit[] = [];
  const serveArgs: string[][] = [];

  const ports = { starter: starterPort(config), relay: relayPort(config) };
  if (PORTS_NEVER_SHARED.includes(ports.starter) || PORTS_NEVER_SHARED.includes(ports.relay)) {
    return refusal(config, 'this config puts a shared service on a port Forge uses for itself');
  }

  const starterOn = config.model_starter?.enabled === true;
  const relayOn = config.cloud_relay?.enabled === true;

  // The starter's lifecycle partner, per `validateModelStarterConfig`: enabling
  // one without the other is a config error, not a warning.
  if (!starterOn && config.control_server?.enabled !== true) {
    edits.push({ path: ['control_server', 'enabled'], value: true });
    notes.push(
      'control_server is turned on as well: the model starter shares its lifecycle state and ' +
        'serialisation chain, so the config needs both. It is loopback-only and stays unshared.',
    );
  }

  if (!starterOn) {
    const block = config.model_starter;
    edits.push(
      block
        ? { path: ['model_starter', 'enabled'], value: true }
        : {
            path: ['model_starter'],
            value: {
              enabled: true,
              port: ports.starter,
              // The ACL mirror, and the honest one: the only port this command
              // shares is the starter's own, so that is the only port a laptop can
              // reach model traffic on. Model ports stay loopback-only.
              shared_ports: [ports.starter],
            },
          },
    );
    notes.push(
      `model_starter is turned on (port ${ports.starter}). A laptop's model requests come in ` +
        `through that one port and are forwarded to the model's own loopback port here.`,
    );
  } else {
    notes.push(`model_starter is already on (port ${ports.starter}).`);
  }

  if (!relayOn) {
    const block = config.cloud_relay;
    if (block) {
      edits.push({ path: ['cloud_relay', 'enabled'], value: true });
      notes.push(
        `cloud_relay is turned on (port ${ports.relay}), sharing the allowlist this config already ` +
          `lists: ${block.models.join(', ') || 'none'}.`,
      );
    } else {
      const allowlist = relayAllowlist(config);
      if (allowlist.length) {
        edits.push({
          path: ['cloud_relay'],
          value: { enabled: true, port: ports.relay, models: allowlist },
        });
        notes.push(
          `cloud_relay is created (port ${ports.relay}) with the key-based cloud models this config ` +
            `knows: ${allowlist.join(', ')}. No key is written: the relay resolves them here.`,
        );
      } else {
        notes.push(
          'cloud_relay stays off: this config has no key-based cloud models to share, so there is ' +
            'nothing for the relay to allow. Add them and run Share again.',
        );
      }
    }
  } else {
    notes.push(`cloud_relay is already on (port ${ports.relay}).`);
  }

  // The relay port is only worth a tailnet share when the relay is on, or this
  // run turns it on: a desktop with nothing to allow has no listener behind that
  // port, and sharing it anyway would leave a laptop hanging on a connection
  // that nothing answers.
  const relayPortWanted = relayOn || edits.some((edit) => edit.path[0] === 'cloud_relay');
  const portsTouched: number[] = [];
  for (const port of [ports.starter, ...(relayPortWanted ? [ports.relay] : [])]) {
    const existing = status?.forwards.get(port);
    if (existing === `127.0.0.1:${port}`) {
      notes.push(`${port} is already shared to 127.0.0.1:${port}; nothing to run for it.`);
      continue;
    }
    if (existing) {
      notes.push(
        `${port} is shared but forwards to ${existing}; the command below re-points it at ` +
          `127.0.0.1:${port}.`,
      );
    }
    serveArgs.push(serveShareArgs(port));
    portsTouched.push(port);
  }
  if (status?.otherPorts.length) {
    notes.push(
      `This computer also shares ${status.otherPorts.join(', ')} in another way; Share leaves those ` +
        `alone.`,
    );
  }
  if (statusFailure) {
    notes.push(
      `Forge could not read what Tailscale already shares (${statusFailure}), so it shows both ` +
        `commands: re-sharing a port that is already shared changes nothing.`,
    );
  }

  return finish(facts, edits, serveArgs, notes, portsTouched, 'share');
}

/** `Stop sharing this computer`: the two switches off, and the two shares
 *  turned off — and only those. A block that does not exist is already off, so
 *  nothing is written for it and no share is removed for it. */
export function planStop(facts: ShareFacts): SharePlan {
  const { config, status, statusFailure } = facts;
  const notes: string[] = [];
  const edits: ConfigEdit[] = [];
  const serveArgs: string[][] = [];
  const ports = { starter: starterPort(config), relay: relayPort(config) };

  for (const [name, block] of [
    ['model_starter', config.model_starter],
    ['cloud_relay', config.cloud_relay],
  ] as const) {
    if (!block) {
      notes.push(`${name} was already off (there is no ${name} block).`);
      continue;
    }
    if (block.enabled !== true) {
      notes.push(`${name} was already off.`);
      continue;
    }
    edits.push({ path: [name, 'enabled'], value: false });
    notes.push(`${name} is turned off; its other settings are left as they were.`);
  }

  const portsTouched: number[] = [];
  for (const port of [ports.starter, ports.relay]) {
    const existing = status?.forwards.get(port);
    if (!existing) {
      notes.push(`${port} is not shared on the tailnet, so there is nothing to turn off for it.`);
      continue;
    }
    if (existing !== `127.0.0.1:${port}`) {
      notes.push(
        `${port} is shared but forwards to ${existing}, which is not Forge's own port, so Share ` +
          `leaves that share alone.`,
      );
      continue;
    }
    serveArgs.push(serveUnshareArgs(port));
    portsTouched.push(port);
  }
  if (statusFailure) {
    notes.push(
      `Forge could not read what Tailscale shares (${statusFailure}), so it shows the two commands ` +
        `for its own ports; turning off a share that is not there changes nothing.`,
    );
  }
  if (status?.otherPorts.length) {
    notes.push(
      `This computer also shares ${status.otherPorts.join(', ')} in another way; Stop sharing ` +
        `leaves those alone.`,
    );
  }

  return finish(facts, edits, serveArgs, notes, portsTouched, 'stop');
}

/** The candidate config with every edit applied, built as a plain object so the
 *  caller can validate it before a single thing changes. Deliberately a small
 *  hand-written merge rather than a generic path setter: the two blocks Share
 *  touches are the two whose required fields the schema checks, and an
 *  incomplete candidate here is a bug this module can see. */
function candidateConfig(config: ForgeConfig, edits: ConfigEdit[]): ForgeConfig {
  const out: ForgeConfig = { ...config };
  for (const edit of edits) {
    if (edit.path.length === 1) {
      Object.assign(out, { [edit.path[0]!]: edit.value });
      continue;
    }
    const key = edit.path[0]! as 'model_starter' | 'cloud_relay' | 'control_server';
    const previous = (out[key] ?? {}) as Record<string, unknown>;
    Object.assign(out, { [key]: { ...previous, [edit.path[1]!]: edit.value } });
  }
  return out;
}

/** Every TCP forward `serve` reports that is NOT one of Forge's own two ports.
 *  `parseServeStatus` puts forwards in `forwards` and non-TCP handlers in
 *  `otherPorts`, so the model ports a person shared by hand before Forge had a
 *  share of its own - on this desktop 8070, 8080-8083, 8090-8092 and 8094 -
 *  live in `forwards` and would otherwise go unmentioned: they are still there
 *  and still reachable after either command, and a run that touched only its own
 *  two ports has to say so rather than let the owner read "sharing is off" as
 *  "the machine is closed". Wording only: neither command touches them. */
function foreignTcpShares(facts: ShareFacts): number[] {
  const { config, status } = facts;
  if (!status) return [];
  const own = new Set([starterPort(config), relayPort(config)]);
  return [...status.forwards.keys()].filter((port) => !own.has(port)).sort((a, b) => a - b);
}

function finish(
  facts: ShareFacts,
  edits: ConfigEdit[],
  serveArgs: string[][],
  notes: string[],
  ports: number[],
  which: 'share' | 'stop',
): SharePlan {
  const { config, executable } = facts;
  const foreign = foreignTcpShares(facts);
  if (foreign.length) {
    const count = `${foreign.length} ${foreign.length === 1 ? 'share' : 'shares'}`;
    notes.push(
      which === 'share'
        ? `This computer also shares ${foreign.join(', ')} to loopback servers through Tailscale. ` +
            `Share touches only the ports Forge listens on (` +
            `${[starterPort(config), relayPort(config)].join(', ')}) and leaves those ${count} ` +
            `exactly as they are.`
        : `This computer also shares ${foreign.join(', ')} to loopback servers through Tailscale. ` +
            `Stop sharing turns off only its own two ports and leaves those ${count} on, so a ` +
            `laptop can still reach them.`,
    );
  }
  return {
    serveArgs,
    shownCommands: serveArgs.map((args) => renderTailscaleCommand(executable, args)),
    ports,
    foreignShares: foreign,
    configEdits: edits,
    notes,
    candidate: candidateConfig(config, edits),
    nothingToDo: !edits.length && !serveArgs.length,
  };
}

/** A run that will not start at all, with the reason: used when the config puts
 *  a shared service on a port Forge uses for itself, where "Share" would mean
 *  forwarding the tailnet at Forge's own admin API or Ollama daemon. */
function refusal(config: ForgeConfig, why: string): SharePlan {
  return {
    serveArgs: [],
    shownCommands: [],
    ports: [],
    foreignShares: [],
    configEdits: [],
    notes: [`Nothing was changed: ${why}.`],
    candidate: config,
    nothingToDo: true,
  };
}

/** The two standing warnings, the record of what a run did to the tailnet and
 *  the messages after it are in `desktopShareText.ts`: a message is not a
 *  decision, and this module has to be able to say what a run does without
 *  knowing how it will be phrased.
 */
