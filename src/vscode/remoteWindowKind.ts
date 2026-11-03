/**
 * The one place that decides what a VS Code remote kind means for this window:
 * is a second computer typing through it, or is this the same computer the
 * extension host already runs on?
 *
 * `vscode.env.remoteName` is set for EVERY remote kind, and the kinds are not
 * alike:
 *
 * - `wsl`, `dev-container` and `attached-container` run the extension host in a
 *   distro or a container ON the machine being typed on. VS Code's own
 *   remote-extension docs say SecretStorage "will always store the secrets on
 *   the client side", wherever the extension host runs, so this window reads its
 *   own computer's keychain, which does hold the keys, and there may be no
 *   second Forge window here to hand anything to. It keeps the local behaviour:
 *   transports, wake relay, model starter, cloud relay, keyed cloud models.
 * - `codespaces` runs the host in a VM the user has to themselves, with no
 *   second Forge window inside it, so it keeps the local behaviour for the same
 *   reason — its own window is the only one that could run those services.
 * - `tunnel` (`code tunnel` on the main machine) and `ssh-remote` are the two
 *   kinds where a second computer is typing at the main machine: the extension
 *   host runs there, the keychain is the typing machine's, and the main
 *   machine's own Forge window already holds the keys and owns the transports
 *   and ports 8797/8798.
 *
 * Only the last two hand their jobs to that window. Every site that used to
 * read `vscode.env.remoteName` to decide now asks here and never branches on
 * the name itself: `vscode/remoteRuntimeSetup.ts` (transports and the wake
 * relay), `vscode/wakeRelaySetup.ts`, `vscode/tailnetServicesSetup.ts` (the
 * model starter and the cloud relay), and `src/extension.ts`, whose answer is
 * passed to `llm/RemoteWindowRoute.ts` (key-based cloud models go to the
 * desktop's relay).
 */

import * as vscode from 'vscode';

/** Remote kinds where a second computer is typing at another machine's own
 *  Forge window. `codespaces` is deliberately absent: that VM holds no second
 *  Forge window, so a codespace window must keep running its own services. */
const HOSTED_ELSEWHERE_KINDS: ReadonlySet<string> = new Set(['tunnel', 'ssh-remote']);

/** Pure, so a test can rule on every kind without pretending to be a window. */
export function remoteKindHostsElsewhere(remoteName: string | undefined): boolean {
  return remoteName !== undefined && HOSTED_ELSEWHERE_KINDS.has(remoteName);
}

/** Whether THIS window is hosted on another computer's behalf. */
export function thisWindowHostedElsewhere(): boolean {
  return remoteKindHostsElsewhere(vscode.env.remoteName);
}
