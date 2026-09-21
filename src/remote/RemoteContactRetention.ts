import type { RemoteStoreState } from './RemoteStoreSchemas';

export function pruneContactState(state: RemoteStoreState, cutoff: number, now: number): void {
  for (const item of state.contactOutbound) {
    if (item.state === 'pending' && item.expiresAt <= now) {
      item.state = 'expired';
      item.updatedAt = now;
    }
  }
  state.contactPending = state.contactPending.filter(
    (item) => item.status === 'pending' || item.updatedAt >= cutoff,
  );
  state.contactGroupLinks = state.contactGroupLinks
    .map((item) =>
      item.state === 'pending' && item.expiresAt <= now
        ? { ...item, state: 'expired' as const, updatedAt: now }
        : item,
    )
    .filter((item) => item.updatedAt >= cutoff || item.state === 'pending')
    .slice(-1_000);
  state.contactOutbound = state.contactOutbound
    .filter(
      (item) => item.updatedAt >= cutoff || item.state === 'pending' || item.state === 'confirmed',
    )
    .slice(-1_000);
  state.contactThread = state.contactThread.slice(-1_000);
}
