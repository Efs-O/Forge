/**
 * When an idle sd-server gets stopped — the one place that answers it.
 *
 * Two watchers race to the same `idle_timeout_ms` deadline. The window that
 * owns the server arms a *local* deadline after its last use, then re-checks
 * the *shared*, cross-window deadline stored in the owner record before it
 * kills anything, because another window may have rendered on that server in
 * the meantime. A window that never owned the server — it adopted it, or its
 * starter died — sweeps the record instead, and reaps through
 * `reconcileSdServerRecord` so the identity decision stays the one every start
 * makes.
 *
 * Split out of `SdServerBackend.ts` (the owner's timer) and
 * `sdServerReconciliation.ts` (the sweep): both carried their own copy of the
 * deadline arithmetic, and the copies had to be kept in step by hand.
 */

import type { SdcppImageBackendConfig } from '../config/types';
import { getLogger } from '../util/logger';
import { sdServerBaseUrl, sdServerSignature } from './sdServerArgs';
import { reconcileSdServerRecord } from './sdServerReconciliation';
import {
  readSdServerRecord,
  sameProcessCreation,
  sameServer,
  type SdProcessIdentity,
  type SdServerOwnerRecord,
} from './sdServerOwnerRecord';

/** What the owner window knows about its own server at the moment of a decision. */
export interface SdServerIdleFacts {
  /**
   * This window has a live child it spawned itself. An adopted server belongs
   * to another window, so it is never this window's to stop.
   */
  ownsProcess: boolean;
  /** The server answered the readiness probe, so an idle stop is a real stop. */
  ready: boolean;
  /** This window is tearing down: it stops the server itself, not through a timer. */
  disposed: boolean;
}

export interface SdServerIdleStopDeps {
  /** `idle_timeout_ms`: both the local and the shared deadline derive from it. */
  idleTimeoutMs: number;
  /**
   * The path of the owner record. It is not read here — `readCurrentRecord`
   * is the reader — it is named in the refusal, so the user can find the file
   * that stopped describing this window's server.
   */
  recordPath: string;
  now: () => number;
  /**
   * Guards read these both when arming and at the deadline; the deadline guard
   * deliberately ignores `ready` and `disposed`, because a server that stopped
   * answering or a window that is tearing down is already handled elsewhere.
   */
  facts: () => SdServerIdleFacts;
  /**
   * The owner record as it is on disk right now, or `undefined` when there is
   * none. Both the shared deadline and the identity check come from it, and
   * `SdServerBackend` supplies the reader so the decision has no filesystem
   * dependency of its own.
   */
  readCurrentRecord: () => Promise<SdServerOwnerRecord | undefined>;
  /** The record this window wrote for the process it owns, or `null` before it has one. */
  ownedRecord: () => SdServerOwnerRecord | null;
  /** Kill this window's server and clean up its record and media lease. */
  stopOwnedProcess: () => Promise<void>;
  /**
   * Where the failure line goes: the backend's output channel, the same sink
   * the record read warnings go to.
   */
  log: (line: string) => void;
}

export interface SdServerIdleStopPolicy {
  /** A use began: no pending idle stop may fire while this window is using the server. */
  useStarted: () => void;
  /** A use ended: remember the local last-use time and arm the deadline. */
  useFinished: () => void;
  /** Arm the local deadline after a successful start, with no use to time from. */
  schedule: () => void;
  /** Cancel a pending stop: a new use, a dispose, an abort, an exit, or a manual stop. */
  clear: () => void;
}

/**
 * The owner window's idle timer. It holds the timer handle, the local last-use
 * time and the count of uses in flight — the three pieces of state that decide
 * whether an idle stop is allowed — and nothing else. `SdServerBackend` drives
 * it from `withActivity` and supplies the facts and the means to stop.
 */
export function createSdServerIdleStopPolicy(deps: SdServerIdleStopDeps): SdServerIdleStopPolicy {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** When *this* window last used the server, or 0 before its first start. */
  let lastLocalUseAt = 0;
  /** Renders this window has in flight; a stop is refused while it is above zero. */
  let uses = 0;

  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const arm = (wait: number): void => {
    timer = setTimeout(() => {
      timer = null;
      void stopWhenIdle().catch((error: unknown) => {
        deps.log(`[Forge] Could not stop idle sd-server: ${errorMessage(error)}`);
      });
    }, wait);
  };

  const schedule = (): void => {
    clear();
    const facts = deps.facts();
    if (uses > 0 || !facts.ownsProcess || !facts.ready || facts.disposed) return;
    if (lastLocalUseAt === 0) lastLocalUseAt = deps.now();
    arm(Math.max(0, lastLocalUseAt + deps.idleTimeoutMs - deps.now()));
  };

  /**
   * The deadline fired. The shared deadline wins: another window's render
   * pushes `record.lastUsedAt` forward, so this window re-arms instead of
   * cutting across it. And a record that names a different process is not this
   * window's server any more, so it refuses rather than killing the wrong pid.
   */
  const stopWhenIdle = async (): Promise<void> => {
    const facts = deps.facts();
    if (uses > 0 || !facts.ownsProcess) return;
    const record = await deps.readCurrentRecord();
    const owned = deps.ownedRecord();
    if (record && owned) {
      if (!sameServer(record, owned)) {
        throw new Error(
          `sd-server owner record "${deps.recordPath}" changed process identity while idle; ` +
            'the running server was left untouched.',
        );
      }
      const sharedDeadline = record.lastUsedAt + deps.idleTimeoutMs;
      if (sharedDeadline > deps.now()) {
        arm(sharedDeadline - deps.now());
        return;
      }
    }
    await deps.stopOwnedProcess();
  };

  return {
    useStarted: (): void => {
      uses++;
      lastLocalUseAt = deps.now();
      clear();
    },
    useFinished: (): void => {
      lastLocalUseAt = deps.now();
      uses--;
      schedule();
    },
    schedule,
    clear,
  };
}

const ORPHAN_SWEEP_INTERVAL_MS = 30_000;

export interface SdServerOrphanMonitorDeps {
  config: SdcppImageBackendConfig;
  recordPath: string;
  fetchImpl: typeof fetch;
  lookupProcess: (pid: number) => Promise<SdProcessIdentity | undefined>;
  terminateProcess: (pid: number) => Promise<void>;
  now: () => number;
}

/** A live configured window's independent watcher for an expired owner record. */
export function startSdServerOrphanMonitor(deps: SdServerOrphanMonitorDeps): {
  dispose: () => void;
} {
  const log = getLogger();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const schedule = (wait = ORPHAN_SWEEP_INTERVAL_MS): void => {
    if (disposed) return;
    timer = setTimeout(
      () => {
        timer = null;
        void sweep()
          .then(schedule)
          .catch((error: unknown) => {
            log.error(`[sdcpp] Idle owner sweep failed for ${deps.config.name}.`, error);
            schedule();
          });
      },
      Math.max(1, wait),
    );
  };
  const sweep = async (): Promise<number> => {
    const record = await readSdServerRecord(deps.recordPath, (message) => log.warn(message));
    if (!record) return ORPHAN_SWEEP_INTERVAL_MS;
    const owner = await deps.lookupProcess(record.ownerPid);
    if (sameProcessCreation(owner, record.ownerCreatedAt)) return ORPHAN_SWEEP_INTERVAL_MS;
    const remaining = record.lastUsedAt + deps.config.idle_timeout_ms - deps.now();
    if (remaining > 0) return remaining;
    await reconcileSdServerRecord(deps.config, record, sdServerSignature(deps.config), {
      lookupProcess: deps.lookupProcess,
      now: deps.now,
      terminateProcess: deps.terminateProcess,
      fetchImpl: deps.fetchImpl,
      recordPath: deps.recordPath,
      baseUrl: sdServerBaseUrl(deps.config),
    });
    return ORPHAN_SWEEP_INTERVAL_MS;
  };
  schedule();
  return {
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
