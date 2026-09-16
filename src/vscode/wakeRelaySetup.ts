import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { RelaySleepServer } from '../remote/RelaySleepServer';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';

/**
 * Start the wake relay if `remote.wake_relay.enabled`. Split out of
 * `extension.ts` (which is at its 500-line `max-lines` hard stop) so the
 * persistent-jobs wiring has room. Behaviour is unchanged: one server, started
 * once, pushed onto the extension's subscriptions, errors surfaced as a toast.
 */
export async function startWakeRelay(
  context: vscode.ExtensionContext,
  config: ForgeConfig,
  forge: ForgeHostFacade,
): Promise<void> {
  const wakeRelay = config.remote?.wake_relay;
  if (!wakeRelay?.enabled) return;
  const relayServer = new RelaySleepServer();
  try {
    await relayServer.start({
      host: wakeRelay.host,
      port: wakeRelay.port,
      relayIp: wakeRelay.relay_ip,
      secrets: context.secrets,
      forge,
      notify: (message) => void vscode.window.showErrorMessage(message),
    });
    context.subscriptions.push(relayServer);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Forge wake relay failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
