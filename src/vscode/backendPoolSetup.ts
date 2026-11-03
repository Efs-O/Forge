import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { BackendPool } from '../backend/BackendPool';
import { ExternalModelServers, setExternalRequestHook } from '../backend/ExternalModelServers';
import { SharedRuntimeRegistry } from '../backend/SharedRuntimeRegistry';
import { ModelStarterLeases } from '../backend/ModelStarterLeases';
import { getLogger } from '../util/logger';

const EXTERNAL_LIFECYCLE_LEASE_KEY = 'external-model-stop-on-exit';

export interface BackendPoolSetup {
  pool: BackendPool;
  externalServers: ExternalModelServers;
  sharedRegistry: SharedRuntimeRegistry;
  remoteLeases: ModelStarterLeases;
  externalLifecycleLeaseId: string;
}

interface ActiveExternalLifecycle {
  pool: BackendPool;
  servers: ExternalModelServers;
  registry: SharedRuntimeRegistry;
  leaseId: string;
  isBusy: (modelName: string) => boolean;
}

let activeExternalLifecycle: ActiveExternalLifecycle | undefined;

/** Create the activation-scoped pool and acquire its shared-runtime lease. */
export function setupBackendPool(
  context: vscode.ExtensionContext,
  config: ForgeConfig,
  getConfig: () => ForgeConfig,
): BackendPoolSetup {
  const externalServers = new ExternalModelServers(getConfig, async (key) =>
    context.secrets.get(key),
  );
  // Reuse the shared-runtime lease registry for cross-window liveness. Its
  // existing PID cleanup means a crashed extension host cannot block shutdown.
  const sharedRegistry = new SharedRuntimeRegistry();
  const externalLifecycleLeaseId = randomUUID();
  sharedRegistry.acquireLease(EXTERNAL_LIFECYCLE_LEASE_KEY, externalLifecycleLeaseId);
  // Remote (laptop) leases on this window's pool pins: the pool drops a lease
  // before releasing that model, so a desktop unload never leaves a pin behind.
  const remoteLeases = new ModelStarterLeases(
    () => (getConfig().model_starter?.lease_ttl_s ?? 600) * 1000,
  );
  const pool = new BackendPool(config, sharedRegistry, externalServers, remoteLeases);
  setExternalRequestHook((model) => pool.prepareExternal(model.name));
  return { pool, externalServers, sharedRegistry, remoteLeases, externalLifecycleLeaseId };
}

export function trackExternalModelLifecycle(options: ActiveExternalLifecycle): void {
  activeExternalLifecycle = options;
}

export function registerExternalModelLifecycleLease(
  context: vscode.ExtensionContext,
  setup: BackendPoolSetup,
): void {
  context.subscriptions.push({
    dispose: () =>
      setup.sharedRegistry.releaseLease(
        EXTERNAL_LIFECYCLE_LEASE_KEY,
        setup.externalLifecycleLeaseId,
      ),
  });
}

export async function deactivateExternalModelLifecycle(): Promise<void> {
  const lifecycle = activeExternalLifecycle;
  activeExternalLifecycle = undefined;
  if (lifecycle) {
    lifecycle.registry.releaseLease(EXTERNAL_LIFECYCLE_LEASE_KEY, lifecycle.leaseId);
    const lastWindow = !lifecycle.registry.hasBorrowers(EXTERNAL_LIFECYCLE_LEASE_KEY);
    await lifecycle.servers.stopOnExit({
      lastWindow,
      isBusy: lifecycle.isBusy,
      leaseDir: lifecycle.registry.leaseDir(EXTERNAL_LIFECYCLE_LEASE_KEY),
    });
    await lifecycle.pool
      .stopAll()
      .catch((error) => getLogger().error('[BackendPool] deactivate stop failed', error));
  }
}
