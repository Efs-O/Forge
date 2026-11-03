/**
 * The keeping-up notice — the last bullet of docs/plans/V1_FINISH_PLAN.md lane 3
 * phase 3.2: once per laptop window, when the desktop answers and lists models
 * this laptop does not have.
 *
 * It lives apart from `desktopConnect.ts` because it is the other half of the
 * same feature with a different shape: the command is a read that WRITES (the
 * owner asked for it), and this is a read that only ASKS. It has its own
 * lifetime (one window, one notice), its own abort (the window closing must
 * cancel it) and its own deadline, and it reuses the command's write path rather
 * than duplicating it — which is the whole reason "Add them" can be one button.
 *
 * The rules it has to honour, and what the tests pin:
 *
 * - **One notice per window, and "Not now" is remembered for that window only.**
 *   Nothing is written to disk, so a laptop that dismissed it is asked again next
 *   start — which is what the plan says, and what keeps a permanently-ignored
 *   desktop model from vanishing forever.
 * - **It never POSTs.** `GET /models` and nothing else: an activation-time read
 *   that started the desktop's GPU would be the defect Connect's own test guards,
 *   arriving on a machine that only wanted to know what was new.
 * - **It does not delete.** A desktop model that went away is left in the laptop
 *   config; the leftover-names warning already reports it, and deleting an entry
 *   the owner hand-wrote is not this notice's job.
 * - **A laptop that has not connected is not noticed.** With no `remote_start`
 *   entries there is no desktop to ask, and Connect's own picker is the right
 *   place to discover one.
 *
 * A desktop that does not answer is not reported here either: that is what
 * "Forge: Check connection" (phase 3.4) is for.
 */

import * as vscode from 'vscode';
import { chooseStarter } from '../llm/RemoteStarterRoute';
import { failureReasonOf, listStarterModels } from '../llm/RemoteStarterHttp';
import { getLogger } from '../util/logger';
import { runConnect, toDesktopRow, errText, type DesktopConnectDeps } from './desktopConnect';
import { starterCandidatesFromConfig, type DesktopModelRow } from './desktopConnectPlan';

const log = getLogger();

/** The notice's own read deadline: the same 10 s Connect uses, declared here
 *  rather than shared, because a notice that has to be fast and a command the
 *  owner started on purpose are not the same promise. */
const KEEPING_UP_READ_TIMEOUT_MS = 10_000;

/** What the notice needs from its window: the config, the config path, and the
 *  injected fetch. Nothing else — it never runs the Tailscale CLI. */
export interface KeepingUpDeps extends DesktopConnectDeps {}

/**
 * Ask once, at activation, and remember the answer for this window.
 *
 * `dispose()` (pushed into `context.subscriptions` as well as returned) is what
 * cancels the in-flight reads: the desktop reads are bounded by their own
 * deadlines, and this abort is what stops a laptop whose window is closing from
 * still writing a notice, or still adding models, after the window is gone.
 */
export function wireDesktopKeepingUp(
  context: vscode.ExtensionContext,
  deps: KeepingUpDeps,
): { dispose(): void; recheck(): Promise<void> } {
  const controller = new AbortController();
  let askedThisWindow = false;
  const hooks = {
    alreadyAsked: () => askedThisWindow,
    markAsked: () => {
      askedThisWindow = true;
    },
    add: (names: string[]) => {
      void runConnect(deps, { onlyNames: new Set(names) })
        .then((message) => {
          if (message) void vscode.window.showInformationMessage(`Forge: ${message}`);
        })
        .catch((error: unknown) => {
          // Nothing awaits this promise, so a write that fails after the owner
          // clicked "Add them" — a `config.yaml` edited badly in between, most
          // often — would vanish without a word. The notice is not the place a
          // failure should die.
          void vscode.window.showErrorMessage(`Forge: ${errText(error)}`);
        });
    },
  };
  // A check that rejects is an unhandled rejection in the extension host, and
  // this one runs at activation where nothing is waiting for it, so every
  // failure — including one from a config that is not fully parsed — is logged
  // here instead of thrown out of `wireDesktopKeepingUp`.
  const check = (): Promise<void> =>
    runKeepingUp(deps, controller.signal, hooks).catch((error: unknown) => {
      log.info(`[Connect] keeping-up check skipped: ${failureReasonOf(error)}`);
    });
  context.subscriptions.push({
    dispose: () => {
      askedThisWindow = true; // a dismissed notice is not re-shown in this window
      controller.abort();
    },
  });
  void check();
  return {
    dispose: () => {
      askedThisWindow = true;
      controller.abort();
    },
    // Exported for the test and for a later config-reload hook: the same check
    // with the same window memory, so "Not now" still holds.
    recheck: check,
  };
}

/** The notice's walk. Only a laptop whose config already dials a desktop gets
 *  one, and only when the desktop answers within the deadline. */
async function runKeepingUp(
  deps: KeepingUpDeps,
  signal: AbortSignal,
  hooks: {
    alreadyAsked: () => boolean;
    markAsked: () => void;
    add: (names: string[]) => void;
  },
): Promise<void> {
  try {
    // A window that is not a laptop's — the desktop itself, or a laptop that has
    // never connected — has no desktop to ask, so it gets no notice and makes no
    // request. `models` is checked because the workspace bootstrap wires this
    // check in a window whose config is not fully parsed yet, and reading
    // `undefined.models` would throw out of an activation-time check.
    const config = deps.getConfig();
    const models = Array.isArray(config.models) ? config.models : [];
    if (!models.some((model) => model.remote_start)) return;
    if (signal.aborted || hooks.alreadyAsked()) return;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const candidates = starterCandidatesFromConfig(config);
    // The same address rule Connect and every prompt use, so the notice cannot
    // report a desktop the laptop is not actually talking to.
    const choice = await chooseStarter(candidates, fetchImpl, signal);
    const listed = await listStarterModels(
      fetchImpl,
      choice.starter,
      KEEPING_UP_READ_TIMEOUT_MS,
      signal,
    );
    if (signal.aborted || hooks.alreadyAsked()) return;
    const known = new Set(models.map((model) => model.name));
    const missing = listed.models
      .map(toDesktopRow)
      .filter((row): row is DesktopModelRow => row !== null)
      .filter((row) => row.remote === true && !known.has(row.name))
      .map((row) => row.name);
    if (!missing.length) return;
    hooks.markAsked();
    const named = missing.slice(0, 6).join(', ');
    const message =
      `The desktop has ${missing.length} ${missing.length === 1 ? 'model' : 'models'} ` +
      `this laptop does not list: ${named}${missing.length > 6 ? `, +${missing.length - 6} more` : ''}.`;
    const picked = await vscode.window.showInformationMessage(message, 'Add them');
    // Re-checked after the button: the window may have closed while the owner
    // was reading, and writing a config then is what the abort is for.
    if (picked === 'Add them' && !signal.aborted) hooks.add(missing);
  } catch (error) {
    // A dead path or a cancelled window is not worth a toast at activation: the
    // laptop will show the same problem the moment it tries to use a model.
    log.info(`[Connect] keeping-up check skipped: ${failureReasonOf(error)}`);
  }
}
