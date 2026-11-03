/**
 * The desktop-side half of the tailnet bridge: `Forge: Share this computer` and
 * `Forge: Stop sharing this computer` (docs/plans/V1_FINISH_PLAN.md lane 3
 * phase 3.3). What lives here is only the parts that need a window, a file or a
 * child process; every rule about which ports, which switches and what the owner
 * is told is in `desktopSharePlan.ts`, where a test can ask it without a tailnet.
 *
 * The invariants, and what the tests pin:
 *
 * - **The commands are shown before anything runs, and run only after the owner
 *   confirms that dialog.** Share is the first thing in Forge that changes
 *   something outside this computer, so it asks first and says exactly what it
 *   will do. Cancelling leaves the file and the tailnet exactly as they were.
 * - **Nothing is touched until the resulting config has been validated.** A
 *   `config.yaml` that would come back invalid — `model_starter` turned on while
 *   `control_server` is off, a port that collides with the control server, a
 *   relay allowlist naming a model that was deleted — is refused before a single
 *   `serve` command runs, so a bad config never leaves a share behind.
 * - **One write, comments kept, the other settings untouched.** The switches are
 *   scalars `setNestedField` edits in place; a block that does not exist is
 *   created whole with the fields its schema requires. The verify hook re-reads
 *   the file and compares, so the guarantee is enforced by the writer rather than
 *   asserted by a test.
 * - **A tunnel or SSH window does nothing at all.** `remoteWindowKind.ts` decides
 *   which kinds those are; in them the desktop's own Forge window owns both
 *   ports and holds nothing here, so Share reads no config, runs no command and
 *   writes nothing, and says which window to run it in.
 * - **The Tailscale CLI is never run in tests** (the lane rule), so it is
 *   injected. In production every call has its own deadline — 4 s for a read,
 *   15 s for a tailnet change — and is cut by this window's abort, so a hung
 *   daemon cannot hang a palette command and a window that closes while a
 *   command is in flight does not leave a child process behind.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as YAML from 'yaml';
import {
  updateConfigFile,
  forgeFileForKey,
  setNestedField,
  deepEqual,
} from '../config/ConfigWriter';
import { defaultPolicyPath } from '../config/PolicyLoader';
import { ForgeConfigSchema } from '../config/schema';
import type { ForgeConfig } from '../config/types';
import { getLogger } from '../util/logger';
import { errText } from './desktopConnect';
import {
  planShare,
  planStop,
  type ConfigEdit,
  type ShareFacts,
  type SharePlan,
} from './desktopSharePlan';
import {
  ACL_NOTE,
  HOSTED_ELSEWHERE_MESSAGE,
  describeShareResult,
  describeStopResult,
  type ServeRun,
} from './desktopShareText';
import { thisWindowHostedElsewhere } from './remoteWindowKind';
import { parseServeStatus, renderTailscaleCommand } from './tailscaleServe';
import {
  TAILSCALE_READ_TIMEOUT_MS,
  TAILSCALE_WRITE_TIMEOUT_MS,
  findTailscaleInstall,
  runTailscaleCli,
} from './tailscaleCli';

const log = getLogger();

/** The command names, contributed in `package.json` and registered from
 *  `workspaceBootstrap.ts`: `src/extension.ts` is at its 500-line cap, so the
 *  registration lives beside the other workspace-activation work. */
export const DESKTOP_SHARE_COMMAND = 'forge.shareComputer';
export const DESKTOP_STOP_SHARING_COMMAND = 'forge.stopSharing';

export interface DesktopShareDeps {
  getConfig(): ForgeConfig;
  /** The config file Share writes into. `forge.configFile` is machine-scoped, so
   *  in the desktop's own window this is the desktop's file — which is the whole
   *  point of running the command in that window. */
  getConfigPath(): string;
  /** Injected so no test ever runs `tailscale` (the lane rule). */
  runTailscale?: (args: string[], signal?: AbortSignal) => Promise<string>;
  /** The path to show and run, resolved by looking for an install without
   *  running anything; injected for the same reason. */
  tailscaleExecutable?: () => string;
}

/** Register both desktop commands. Called from `workspaceBootstrap.ts`, which is
 *  where the config and its path are already in hand.
 *
 *  The abort controller in `context.subscriptions` is what cancels a `serve`
 *  child process when the window deactivates or the extension deactivates: each
 *  call also has its own deadline, so nothing here can wait forever even if the
 *  context never disposes.
 */
export function registerDesktopShareCommands(
  context: vscode.ExtensionContext,
  deps: DesktopShareDeps,
): void {
  const controller = new AbortController();
  context.subscriptions.push({
    dispose: () => controller.abort(),
  });
  context.subscriptions.push(
    vscode.commands.registerCommand(DESKTOP_SHARE_COMMAND, () =>
      runCommand(deps, controller.signal, 'share'),
    ),
    vscode.commands.registerCommand(DESKTOP_STOP_SHARING_COMMAND, () =>
      runCommand(deps, controller.signal, 'stop'),
    ),
  );
}

/** The whole run of either command. Returns the message to show, and never
 *  throws: a palette command that rejects tells the owner nothing, so every
 *  failure comes back as text with the reason and the fix. */
export async function runCommand(
  deps: DesktopShareDeps,
  signal: AbortSignal,
  which: 'share' | 'stop',
): Promise<string> {
  try {
    if (thisWindowHostedElsewhere()) {
      // Read nothing, write nothing, run nothing: see the header.
      log.info(`[Share] ${which} ignored in a hosted window`);
      return HOSTED_ELSEWHERE_MESSAGE;
    }
    const config = deps.getConfig();
    const executable = deps.tailscaleExecutable?.() ?? findTailscaleInstall() ?? 'tailscale';
    const facts = await readFacts(deps, config, executable, signal);
    const plan = which === 'share' ? planShare(facts) : planStop(facts);
    if (plan.nothingToDo) return `Nothing was run and nothing was written. ${plan.notes.join(' ')}`;
    // Before any change, tailnet or file: see the header. `candidate` is the
    // config this run would produce, so this is the last chance to back out
    // without having exposed anything.
    const invalid = validateCandidate(plan.candidate);
    if (invalid) {
      return `Nothing was run and nothing was written, because the config this would produce is not valid: ${invalid}`;
    }
    const confirmed = await confirm(which, plan);
    if (!confirmed) return 'Cancelled: nothing was run and nothing was written.';
    if (signal.aborted) return 'Cancelled: this window closed before the change was made.';
    // A run that found both switches already right has nothing to write, and
    // writing the document anyway would re-serialize the whole file: the owner's
    // `shared_ports: [8080, 8081]` would come back re-padded for no reason, and
    // `updateConfigFile` would leave another `.bak`. So `wrote` here means "the
    // file needed a change and got one", which is what the message says.
    const needed = plan.configEdits.length > 0;
    const wrote = needed ? writeSwitches(deps.getConfigPath(), plan) : false;
    if (needed && !wrote) {
      return (
        'The write was refused and config.yaml was left exactly as it was: the switches did not ' +
        'come back as they were written. Fix the file, or run the commands yourself — no ' +
        '`tailscale` command was run.'
      );
    }
    const ran = await runServeCommands(deps, plan, executable, signal);
    // The commands belong in the log, not only their count: whoever checks this
    // desktop afterwards reads the line and has to see which `serve` change
    // actually ran, because "the switch is on and the share is not" is the state
    // a laptop cannot tell from the outside.
    log.info(
      `[Share] ${which}: wrote ${plan.configEdits.length} ${
        plan.configEdits.length === 1 ? 'edit' : 'edits'
      }, ran ${ran.filter((run) => run.ok).length}/${ran.length} commands — ` +
        `${ran.map((run) => `${run.ok ? 'ran' : 'did not run'}: ${run.command}`).join('; ')} | ${plan.notes.join(' ')}`,
    );
    const outcome = {
      ran,
      wrote,
      configEdits: plan.configEdits.length,
      leftShared: plan.foreignShares,
    };
    return which === 'share' ? describeShareResult(outcome) : describeStopResult(outcome);
  } catch (error) {
    // A command that rejects is a silent failure in the extension host, and this
    // one has just changed the owner's tailnet: the reason has to be shown.
    log.warn(`[Share] ${which} failed: ${errText(error)}`);
    return `This did not complete: ${errText(error)}`;
  }
}

/** `tailscale serve status --json`, read only, and never fatal: an unread
 *  tailnet is reported as such and the plan still shows its commands, because
 *  re-sharing a port that is already shared changes nothing, while assuming a
 *  share is already there when it is not would leave a laptop unable to connect
 *  with a message that says everything is fine. */
async function readFacts(
  deps: DesktopShareDeps,
  config: ForgeConfig,
  executable: string,
  signal: AbortSignal,
): Promise<ShareFacts> {
  const args = ['serve', 'status', '--json'];
  let status = null;
  let statusFailure: string | null = null;
  try {
    status = parseServeStatus(await (deps.runTailscale ?? defaultRunTailscale)(args, signal));
  } catch (error) {
    statusFailure = errText(error);
  }
  return { config, executable, status, statusFailure };
}

/** Reads get the 4 s deadline a convenience gets; a `serve` change gets the
 *  longer one, because it applies tailnet configuration. Both are bounded, and
 *  both honour the caller's abort, so the worst case is a reported failure
 *  rather than a command that never comes back. */
function defaultRunTailscale(args: string[], signal?: AbortSignal): Promise<string> {
  const reading = args[0] === 'serve' && (args[1] === 'status' || args[1] === 'get-config');
  return runTailscaleCli(args, {
    timeoutMs: reading ? TAILSCALE_READ_TIMEOUT_MS : TAILSCALE_WRITE_TIMEOUT_MS,
    signal,
  });
}

/** The modal dialog: the plan's notes, then the exact commands, then the one
 *  thing Forge cannot do for the owner. Built here rather than in the plan module
 *  because it is the shape of a VS Code dialog, not a decision.
 *
 *  The buttons are the plan's own verb, so a run cannot be confirmed by a word
 *  that means something else; anything else - including `Esc` and the close box -
 *  is a cancellation, which is what `runCommand` reports as "nothing was run". */
async function confirm(which: 'share' | 'stop', plan: SharePlan): Promise<boolean> {
  const verb = which === 'share' ? 'Share' : 'Stop sharing';
  const heading =
    which === 'share'
      ? 'Share this computer\u2019s Forge models with a laptop on your tailnet?'
      : 'Stop sharing this computer with laptops on your tailnet?';
  const body =
    `${heading}\n\nWhat Forge will do:\n${plan.notes.map((note) => `  • ${note}`).join('\n')}` +
    `${plan.shownCommands.length ? `\n\nCommands to run:\n${plan.shownCommands.map((command) => `  ${command}`).join('\n')}` : ''}\n\n${ACL_NOTE}`;
  const picked = await vscode.window.showInformationMessage(
    body,
    { modal: true, detail: confirmDetail(which, plan) },
    verb,
  );
  return typeof picked === 'string' && picked.length > 0;
}

/** The dialog's second line, shown under the message: exactly what this run
 *  touches and what it does not, in numbers rather than adjectives. A dialog
 *  that only says "Tailscale and config.yaml" cannot be read as consent to two
 *  named ports and a named number of switches. */
function confirmDetail(which: 'share' | 'stop', plan: SharePlan): string {
  const ports = plan.ports.length ? ` (ports ${plan.ports.join(', ')})` : '';
  const shares = `${plan.serveArgs.length} ${plan.serveArgs.length === 1 ? 'share' : 'shares'}${ports}`;
  const switches = `${plan.configEdits.length} ${plan.configEdits.length === 1 ? 'change' : 'changes'}`;
  return which === 'share'
    ? `Tailscale: ${shares}. config.yaml: ${switches}. No ACL, Tailnet Lock or sign-in change.`
    : `Tailscale: ${shares}. config.yaml: ${switches}. Every other share on this computer is left alone.`;
}

/** The write, one call per file. `verify` re-reads the file it wrote and compares
 *  each edit against what was asked, so a `setNestedField` that created the block
 *  but lost a required field comes back as a refused write with the bytes restored.
 *
 *  Edits are grouped by the file that owns their top-level key: `control_server`,
 *  `model_starter` and `cloud_relay` are policy keys, so once the owner has
 *  migrated them they live in `~/.forge/policy.yaml`, and a write that put them
 *  back into config.yaml would create exactly the duplicate key the loader
 *  refuses. Before the migration there is one group, one call, one file — exactly
 *  as before this change. */
function writeSwitches(configPath: string, plan: SharePlan): boolean {
  const byTarget = new Map<'config' | 'policy', ConfigEdit[]>();
  for (const edit of plan.configEdits) {
    const target = forgeFileForKey(String(edit.path[0]));
    const list = byTarget.get(target);
    if (list) list.push(edit);
    else byTarget.set(target, [edit]);
  }
  if (byTarget.size === 0) {
    return updateConfigFile(
      configPath,
      () => {},
      () => everyEditLanded(configPath, plan),
    );
  }
  let landed = true;
  for (const [target, edits] of byTarget) {
    const ok = updateConfigFile(
      configPath,
      (doc) => {
        for (const edit of edits) setNestedField(doc, edit.path, edit.value);
      },
      () =>
        everyEditLanded(target === 'policy' ? defaultPolicyPath() : configPath, {
          ...plan,
          configEdits: edits,
        }),
      { target },
    );
    landed = landed && ok;
  }
  return landed;
}

function everyEditLanded(configPath: string, plan: SharePlan): boolean {
  let parsed: unknown;
  try {
    // Read once: this runs while the config lock is held, so a second read of
    // the same file would only add another chance of seeing something else.
    parsed = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return false;
  }
  if (parsed === null || parsed === undefined) return plan.configEdits.length === 0;
  const doc = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return plan.configEdits.every((edit) => {
    let node: unknown = doc;
    for (const key of edit.path) {
      if (!node || typeof node !== 'object') return false;
      node = (node as Record<string, unknown>)[key];
    }
    // A created block is compared field by field: `lease_ttl_s` and
    // `max_body_mb` are schema defaults the writer never saw, so requiring them
    // to be in the file would fail a write that is actually correct. The compare
    // has to be DEEP: `shared_ports` and `models` are arrays, and `===` between
    // two equal arrays is false, so a shallow compare reported a correct write as
    // refused and restored bytes that were right — which is how a Share run that
    // wrote everything came back saying nothing was written.
    if (typeof edit.value === 'object' && edit.value !== null) {
      return (
        node !== undefined &&
        typeof node === 'object' &&
        Object.entries(edit.value).every(([key, value]) =>
          deepEqual((node as Record<string, unknown>)[key], value),
        )
      );
    }
    return deepEqual(node, edit.value);
  });
}

/** Validate the config this run would produce, before touching anything. Issues
 *  are quoted as the schema wrote them, because the fix is in those words: the
 *  common one is `model_starter.enabled requires control_server.enabled: true`,
 *  which Share turns on for you when it can and reports when it cannot. */
function validateCandidate(candidate: ForgeConfig): string | null {
  const parsed = ForgeConfigSchema.safeParse(candidate);
  if (parsed.success) return null;
  return parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
    .join('; ');
}

/** The commands, in order, each one recorded whether it worked. A failure does
 *  not stop the others: one port can be shared while the other is not, and the
 *  owner needs both lines to paste. `signal` is this window's abort, so a window
 *  that closes mid-run cuts the child process rather than leaving it applying
 *  tailnet changes nobody asked for any more. */
async function runServeCommands(
  deps: DesktopShareDeps,
  plan: SharePlan,
  executable: string,
  signal: AbortSignal,
): Promise<ServeRun[]> {
  const run = deps.runTailscale ?? defaultRunTailscale;
  const ran: ServeRun[] = [];
  for (const args of plan.serveArgs) {
    const command = renderTailscaleCommand(executable, args);
    if (signal.aborted) {
      ran.push({ command, ok: false, error: 'cancelled by this window closing' });
      continue;
    }
    try {
      await run(args, signal);
      ran.push({ command, ok: true });
    } catch (error) {
      ran.push({ command, ok: false, error: errText(error) });
    }
  }
  // Tailscale's own stdout for a `serve` change is a confirmation line the owner
  // does not need: the line that matters names the command that failed, in the
  // same words the dialog showed before it ran.
  return ran;
}
