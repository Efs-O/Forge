/**
 * `RemoteTransportManager.takeOver`: how long a window keeps trying for the
 * transport lease, and what it does when it decides to stop.
 *
 * Before phase 2 this loop was five attempts of two seconds each, it returned
 * quietly when they ran out, and nothing could cancel it — so a window whose
 * target was still starting gave up on a chat that was on its way, and a window
 * that was shutting down kept looping. The lease here is faked at the module
 * boundary the manager actually imports, so these tests are about the retry
 * policy and not about `FileLease`'s own behaviour (that is
 * `FileLease.test.ts` and `StaleLeaseRealProcess.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import { RemoteLeaseError, RemoteTransportLease } from '../../src/remote/RemoteTransportLease';
import { RemoteTransportManager } from '../../src/remote/RemoteTransportManager';
import { TAKEOVER_CLAIM_DEADLINE_MS } from '../../src/remote/RemoteTransportManager';
import type { RemoteAuditLog } from '../../src/remote/RemoteAuditLog';
import type { RemoteAuth } from '../../src/remote/RemoteAuth';
import type { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteControllerOptionsDeps } from '../../src/remote/remoteControllerOptions';
import type { RemoteRuntimeOptions } from '../../src/remote/types';

vi.mock('../../src/remote/RemoteTransportLease', () => {
  class FakedLeaseError extends Error {}
  return {
    RemoteLeaseError: FakedLeaseError,
    RemoteTransportLease: {
      acquire: vi.fn(async () => {
        throw new FakedLeaseError('Forge lease "telegram" is already owned by another window.');
      }),
    },
  };
});

const acquire = vi.mocked(RemoteTransportLease.acquire);

const config = ForgeConfigSchema.parse({
  models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
  remote: { enabled: true, telegram: { enabled: true } },
});

/** A manager whose transports cannot start because another window holds the
 *  lease: `reconcileDeadClaims` runs before the lease is asked for, so these
 *  stubs never have to behave like the real store. */
function managerHeldOut(): RemoteTransportManager {
  const store = {
    reconcileDeadClaims: async () => undefined,
    cursor: () => undefined,
    setCursor: async () => undefined,
    setClaimOwner: vi.fn(),
  } as unknown as RemoteRequestStore;
  return new RemoteTransportManager(
    {
      storageDirectory: 'unused',
      workspaceId: 'workspace',
      host: {} as never,
      notifyLocal: vi.fn(),
      // A factory has to exist for `startTransport` to reach the lease at all:
      // without one it returns early, and the retry loop would never see a
      // refusal. It is never called here, because the lease throws first.
      channelFactories: { telegram: async () => ({}) as never },
    } as unknown as RemoteRuntimeOptions,
    store,
    {} as unknown as RemoteAuth,
    {} as unknown as RemoteAuditLog,
    {} as unknown as RemoteControllerOptionsDeps,
    vi.fn(),
    async () => undefined,
    vi.fn(),
    vi.fn(),
  );
}

describe('takeOver retry', () => {
  it('retries until the deadline passes and then reports the last refusal', async () => {
    acquire.mockClear();
    const manager = managerHeldOut();
    const startedAt = Date.now();
    await expect(manager.takeOver(config, { deadlineMs: 120 })).rejects.toThrow(
      /already owned by another window/,
    );
    // Quiet success was the old defect: the caller could not tell "no lease"
    // from "leaseless and gave up", and claimed a chat it could not serve. The
    // message itself is handed on unchanged, so a second window's start failure
    // reads exactly as it always has.
    expect(acquire.mock.calls.length).toBeGreaterThan(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  });

  /**
   * The plan's first question, answered for the longest wait phase 2 adds: the
   * claim deadline has to outlast the 20 s stale horizon, or a window that is
   * merely slow loses the chat it was handed.
   */
  it('the claim deadline outlasts the 20 s stale horizon it has to wait past', () => {
    expect(TAKEOVER_CLAIM_DEADLINE_MS).toBeGreaterThan(20_000);
  });

  it('an abort stops the retry mid-loop and still surfaces the failure', async () => {
    acquire.mockClear();
    const manager = managerHeldOut();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 40);
    const startedAt = Date.now();
    await expect(
      manager.takeOver(config, { deadlineMs: 10_000, signal: abort.signal }),
    ).rejects.toBeInstanceOf(RemoteLeaseError);
    // Stopped at the abort, not at the deadline: a window that is shutting down
    // must not sit in the loop for the full claim deadline.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(acquire.mock.calls.length).toBeLessThan(8);
  });

  it('a failure that is not the lease is reported at once, not retried', async () => {
    acquire.mockReset();
    acquire.mockImplementation(async () => {
      throw new Error('bot token rejected');
    });
    const manager = managerHeldOut();
    await expect(manager.takeOver(config, { deadlineMs: 5_000 })).rejects.toThrow(
      'bot token rejected',
    );
    expect(acquire).toHaveBeenCalledTimes(1);
    acquire.mockImplementation(async () => {
      throw new RemoteLeaseError('Forge lease "telegram" is already owned by another window.');
    });
  });
});
