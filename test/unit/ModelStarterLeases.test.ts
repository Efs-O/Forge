/**
 * The remote lease bookkeeping (docs/plans/LAPTOP_MODEL_STARTER_PLAN.md,
 * "Lease model"). The plan's CI-enforced pair to `ModelStarterSurface.test.ts`:
 * exactly-once release. A pin dropped twice frees a model someone is still
 * using; a pin never dropped leaves the model looking busy for the rest of the
 * window's life — never evicted, never stopped on exit, and the laptop's model
 * kept loaded by a laptop that has gone away.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ModelStarterLeases,
  LEASE_SWEEP_INTERVAL_MS,
  type RemoteLease,
} from '../../src/backend/ModelStarterLeases';

const TTL_MS = 600_000;

function harness(ttlMs = TTL_MS) {
  let clock = 1_700_000_000_000;
  const leases = new ModelStarterLeases(() => ttlMs, () => clock);
  const grants: Array<{ lease: RemoteLease; unpin: () => void }> = [];
  const advance = (ms: number) => {
    clock += ms;
  };
  const grant = (client: string, model: string, port = 8080) => {
    const unpin = vi.fn();
    const lease = leases.grant({ client, model, port, kind: 'llama.cpp', release: unpin });
    grants.push({ lease, unpin });
    return { lease, unpin };
  };
  /** The `unpin` actually called for a model, counting real calls only. */
  const unpinCalls = (model: string): number =>
    grants
      .filter((entry) => entry.lease.model === model)
      .reduce((total, entry) => total + entry.unpin.mock.calls.length, 0);
  return { leases, clock: () => clock, advance, grant, unpinCalls };
}

describe('ModelStarterLeases', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sets the expiry one TTL out and pushes it out on renewal', () => {
    const { leases, clock, advance, grant } = harness();
    const { lease } = grant('laptop-1', 'gemma-iq3s');
    expect(lease.expiresAt).toBe(clock() + TTL_MS);
    advance(TTL_MS / 3);
    leases.renew(lease);
    expect(lease.expiresAt).toBe(clock() + TTL_MS);
    expect(leases.find('laptop-1', 'gemma-iq3s')).toBe(lease);
    expect(leases.size).toBe(1);
  });

  it('releasing a lease drops its pin exactly once, however many paths reach it', () => {
    const { leases, advance, grant, unpinCalls } = harness();
    const { lease } = grant('laptop-1', 'gemma-iq3s');
    leases.renew(lease);
    leases.release(lease);
    leases.release(lease);
    leases.releaseLeasesFor('gemma-iq3s');
    leases.releaseClient('laptop-1');
    advance(TTL_MS * 2);
    leases.expireNow();
    leases.dispose();
    expect(unpinCalls('gemma-iq3s')).toBe(1);
    expect(leases.size).toBe(0);
  });

  it('expires a lease at its TTL and keeps a renewed one', () => {
    const { leases, advance, grant, unpinCalls } = harness();
    const doomed = grant('laptop-1', 'gemma-iq3s');
    const kept = grant('laptop-1', 'gemma-iq2xs'); // switching models frees the first
    expect(unpinCalls('gemma-iq3s')).toBe(1);
    const held = leases.find('laptop-1', 'gemma-iq2xs');
    expect(held).toBe(kept.lease);
    advance(TTL_MS - 1_000);
    leases.renew(held!);
    advance(500);
    leases.expireNow();
    expect(unpinCalls('gemma-iq2xs')).toBe(0);
    expect(leases.hasLease('gemma-iq2xs')).toBe(true);
    advance(TTL_MS);
    leases.expireNow();
    expect(unpinCalls('gemma-iq2xs')).toBe(1);
    expect(leases.hasLease('gemma-iq2xs')).toBe(false);
  });

  it('the 30 s sweep releases what has expired, and only while watching', () => {
    const { leases, advance, grant, unpinCalls } = harness(60_000);
    const { lease } = grant('laptop-1', 'gemma-iq3s');
    // Time passes and the sweep runs at the same rate: the injected clock and
    // the timer must move together, or the test is measuring its own bookkeeping.
    const tick = (ms: number) => {
      advance(ms);
      vi.advanceTimersByTime(ms);
    };
    leases.startWatching();
    tick(30_000); // half its life: still leased
    expect(leases.hasLease('gemma-iq3s')).toBe(true);
    expect(unpinCalls('gemma-iq3s')).toBe(0);
    tick(30_000); // a full TTL has passed
    expect(unpinCalls('gemma-iq3s')).toBe(1);
    expect(leases.hasLease('gemma-iq3s')).toBe(false);
    // A window that is not the owner never starts the sweep, so it never
    // releases anything it did not grant.
    const idle = new ModelStarterLeases(() => 60_000, () => 0);
    const stale = idle.grant({
      client: 'laptop',
      model: 'x',
      port: 8080,
      kind: 'llama.cpp',
      release: vi.fn(),
    });
    vi.advanceTimersByTime(LEASE_SWEEP_INTERVAL_MS * 4);
    expect(idle.hasLease(stale.model)).toBe(true);
    idle.dispose();
    expect(idle.hasLease(stale.model)).toBe(false);
    expect(lease.model).toBe('gemma-iq3s');
  });

  it('one lease per client: an ensure for another model releases the old one', () => {
    const { leases, grant, unpinCalls } = harness();
    grant('laptop-1', 'strata-iq3s', 8090);
    grant('laptop-1', 'gemma-iq2xs');
    expect(leases.size).toBe(1);
    expect(unpinCalls('strata-iq3s')).toBe(1);
    expect(unpinCalls('gemma-iq2xs')).toBe(0);
    expect(leases.clientsFor('strata-iq3s')).toEqual([]);
    expect(leases.clientsFor('gemma-iq2xs')).toEqual(['laptop-1']);
  });

  it('releaseClientExcept frees what a model switch leaves behind, not the target', () => {
    const { leases, grant, unpinCalls } = harness();
    // Two clients can lease two different models at once.
    grant('laptop-a', 'gemma-iq3s');
    grant('laptop-b', 'strata-iq3s', 8090);
    expect(leases.releaseClientExcept('laptop-a', 'gemma-iq3s')).toEqual([]);
    expect(leases.size).toBe(2);
    expect(leases.releaseClient('laptop-b')).toEqual(['strata-iq3s']);
    expect(unpinCalls('strata-iq3s')).toBe(1);
    expect(leases.size).toBe(1);
  });

  it('releaseLeasesFor frees a model a desktop unload is about to take, from any client', () => {
    const { leases, grant, unpinCalls } = harness();
    grant('laptop-a', 'gemma-iq3s');
    grant('laptop-b', 'gemma-iq3s');
    expect(leases.hasLease('gemma-iq3s')).toBe(true);
    leases.releaseLeasesFor('gemma-iq3s');
    expect(leases.hasLease('gemma-iq3s')).toBe(false);
    expect(unpinCalls('gemma-iq3s')).toBe(2);
    expect(leases.size).toBe(0);
    // Releasing a model nobody leased is a no-op, which is what makes it safe
    // for BackendPool to call on every release.
    leases.releaseLeasesFor('gemma-iq2xs');
    expect(unpinCalls('gemma-iq2xs')).toBe(0);
  });

  it('releaseAllLeases and dispose release everything once each', () => {
    const { leases, grant, unpinCalls } = harness();
    grant('laptop-a', 'gemma-iq3s');
    grant('laptop-b', 'strata-iq3s', 8090);
    expect(leases.releaseAllLeases()).toBe(2);
    expect(unpinCalls('gemma-iq3s')).toBe(1);
    expect(unpinCalls('strata-iq3s')).toBe(1);
    leases.dispose();
    expect(leases.releaseAllLeases()).toBe(0);
    expect(unpinCalls('gemma-iq3s')).toBe(1);
  });

  it('hasLease is true only for a live lease, which is what stopOnExit needs', () => {
    const { leases, advance, grant } = harness(30_000);
    expect(leases.hasLease('gemma-iq3s')).toBe(false);
    grant('laptop-1', 'gemma-iq3s');
    expect(leases.hasLease('gemma-iq3s')).toBe(true);
    expect(leases.hasLease('gemma-iq2xs')).toBe(false);
    advance(30_000);
    leases.expireNow();
    expect(leases.hasLease('gemma-iq3s')).toBe(false);
  });
});
