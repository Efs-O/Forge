import type { ForgeConfig } from '../config/types';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteTransportManager } from './RemoteTransportManager';
import type { RemoteValidationStatus } from './types';

export async function buildRemoteValidationStatus(
  config: ForgeConfig,
  manager: RemoteTransportManager,
  auth: RemoteAuth,
  store: RemoteRequestStore,
): Promise<RemoteValidationStatus> {
  const transports: RemoteValidationStatus['transports'] = [];
  for (const name of ['telegram', 'whatsapp'] as const) {
    const configured = config.remote?.enabled === true && config.remote[name].enabled === true;
    const active = manager.get(name);
    const leaseOwned = active ? await active.lease.verify() : false;
    let health = {
      ok: active !== undefined,
      detail: active ? 'Transport is active; no provider probe is available.' : 'Not active.',
    };
    if (active?.channel.healthCheck) {
      try {
        health = await active.channel.healthCheck();
      } catch (err) {
        health = {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
    transports.push({
      name,
      configured,
      active: active !== undefined,
      ownerPaired: await auth.hasOwner(name),
      totpEnrolled: await auth.totpEnrolled(name),
      leaseOwned,
      providerOk: health.ok,
      detail: health.detail,
    });
  }
  return {
    enabled: config.remote?.enabled === true,
    transports,
    requests: store.requestHealth(),
    outbox: store.outboxHealth(),
  };
}
