import * as path from 'path';
import { isHostAlive, type HostLivenessDeps } from '../agentMesh/hostIdentity';
import { FileLease } from '../util/FileLease';
import type { RemoteRequestRecord } from './types';
import type { RemoteStoreState } from './RemoteStoreSchemas';

/** A running record is recoverable only when its transport owner is proven gone. */
export function isRemoteClaimOwnerLive(
  storeFile: string,
  request: RemoteRequestRecord,
  liveness: HostLivenessDeps = {},
): boolean {
  const lease = FileLease.currentClaimIdentity(
    path.join(path.dirname(storeFile), 'remote-leases'),
    request.channel,
  );
  if (lease === 'unreadable') return true;
  if (request.claimOwner) {
    if (!isHostAlive(request.claimOwner, liveness)) return false;
    return lease?.token === request.claimOwner.token;
  }
  // Legacy running rows have no epoch. A live lease may still be processing
  // one in an older window; keep it until that owner is proven dead.
  return lease !== undefined && isHostAlive(lease, liveness);
}

/** Startup reconciliation, under the shared remote-state lock. */
export function recoverInterruptedRemoteState(draft: RemoteStoreState, storeFile: string): void {
  recoverDeadClaims(draft, storeFile);
  for (const item of draft.outbox) {
    if (item.state === 'sending') item.state = 'pending';
  }
  for (const receipt of draft.controlReceipts) {
    if (receipt.state === 'pending') receipt.state = 'unknown';
  }
}

/** Also called before a later claim if this process restarted a transport. */
export function recoverDeadClaims(draft: RemoteStoreState, storeFile: string): void {
  const now = Date.now();
  for (const request of draft.requests) {
    if (request.state === 'running' && !isRemoteClaimOwnerLive(storeFile, request)) {
      request.state = 'unknown';
      delete request.claimOwner;
      request.updatedAt = now;
    }
  }
}
