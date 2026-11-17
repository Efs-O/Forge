import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { BackendPool } from '../backend/BackendPool';
import type { ControlServer } from '../backend/ControlServer';
import type { ModelStarterLeases } from '../backend/ModelStarterLeases';
import { wireModelStarter } from '../backend/ModelStarterServer';
import { wireCloudRelay } from '../llm/CloudRelayServer';
import type { RemoteMediaJobs } from '../media/remoteMediaJobs';
import { thisWindowHostedElsewhere } from './remoteWindowKind';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface TailnetServicesWiring {
  applyConfig(): void;
  dispose(): void;
}

/** Assemble the two independent loopback services exposed by `tailscale serve`. */
export function wireTailnetServices(
  context: vscode.ExtensionContext,
  getConfig: () => ForgeConfig,
  pool: BackendPool,
  controlServer: ControlServer,
  leases: ModelStarterLeases,
  /** Build the laptop media jobs, for the window that owns the relay. Called
   *  only there: a hosted window wires no media, so it never opens the job
   *  store or starts its sweep. */
  makeMedia?: () => RemoteMediaJobs,
): TailnetServicesWiring {
  if (thisWindowHostedElsewhere()) {
    // A VS Code tunnel or SSH window shares the desktop with its own Forge
    // window, which owns 8797 and 8798. `TailnetListener` only warns on
    // EADDRINUSE, so a window that won the bind race (the desktop window
    // reloading) would serve the cloud relay with no keys in its SecretStorage,
    // and — once hosted windows forward keyed requests to the relay — would
    // forward its own requests to itself. Binding neither is the fix; the no-op
    // wiring keeps `applyConfig`/`dispose` callers unchanged. A WSL, container
    // or Codespaces window is this machine's only Forge window, so
    // `remoteWindowKind.ts` leaves it wiring both, exactly as a local window.
    log.info(
      `The model starter and cloud relay run in the desktop's own Forge window, ` +
        `not in this VS Code Remote window.`,
    );
    const hostedElsewhere: TailnetServicesWiring = {
      applyConfig: () => undefined,
      dispose: () => undefined,
    };
    context.subscriptions.push(hostedElsewhere);
    return hostedElsewhere;
  }
  const starter = wireModelStarter(getConfig, pool, controlServer, leases);
  const media = makeMedia?.();
  if (media) context.subscriptions.push(media);
  const relay = wireCloudRelay(context, getConfig, media);
  const wiring: TailnetServicesWiring = {
    applyConfig: () => {
      starter.applyConfig();
      relay.applyConfig();
    },
    dispose: () => {
      starter.dispose();
      relay.dispose();
    },
  };
  context.subscriptions.push(wiring);
  return wiring;
}
