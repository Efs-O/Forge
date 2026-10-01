import type { ChildProcess } from 'child_process';
import type { SdcppImageBackendConfig } from '../config/types';
import { verifySdServerAdoption } from './sdServerAdoption';
import {
  deleteSdServerRecord,
  sameExecutablePath,
  sameProcessCreation,
  waitForSdProcessExit,
  type SdProcessIdentity,
  type SdServerOwnerRecord,
} from './sdServerOwnerRecord';

/**
 * The two Windows process-identity decisions `SdServerBackend` makes when it
 * starts, kept apart from the process itself: what an existing owner record
 * means for this window, and what a freshly spawned child must be proven to be
 * before it gets a record. Both exist because Windows reuses PIDs, so "alive"
 * means pid plus creation time, and killing the wrong pid is the worst failure
 * this backend has. `SdServerBackend` stays the only owner of the child, the
 * idle timer, and the record file; these functions only decide.
 */

export interface SdProcessLookup {
  lookupProcess: (pid: number) => Promise<SdProcessIdentity | undefined>;
  now: () => number;
}

/**
 * Decide what an existing owner record means.
 *
 * Returns the record to adopt, or `undefined` when this window must spawn its
 * own server (dead record deleted, or verified orphan reaped). Throws when the
 * port is held by something Forge must not touch — the refusal names the pid,
 * the port, and the executable that made it unverifiable.
 */
export async function reconcileSdServerRecord(
  config: SdcppImageBackendConfig,
  record: SdServerOwnerRecord,
  signature: string,
  deps: SdProcessLookup & {
    terminateProcess: (pid: number) => Promise<void>;
    fetchImpl: typeof fetch;
    recordPath: string;
    baseUrl: string;
  },
): Promise<SdServerOwnerRecord | undefined> {
  const [ownerIdentity, serverIdentity] = await Promise.all([
    deps.lookupProcess(record.ownerPid),
    deps.lookupProcess(record.pid),
  ]);
  const ownerAlive = sameProcessCreation(ownerIdentity, record.ownerCreatedAt);
  const serverAlive = sameProcessCreation(serverIdentity, record.pidCreatedAt);
  if (!serverAlive) {
    await deleteSdServerRecord(deps.recordPath);
    return undefined;
  }
  if (!serverIdentity) {
    throw new Error(`Get-CimInstance omitted identity for sd-server pid ${record.pid}.`);
  }
  if (!ownerAlive && serverAlive) {
    const activeUntil = record.lastUsedAt + config.idle_timeout_ms;
    if (activeUntil > deps.now()) {
      throw new Error(
        `sdcpp port ${record.port} is held by recently used pid ${record.pid}; ` +
          `Forge will not interrupt its possible in-flight request. Retry after ${new Date(activeUntil).toISOString()}.`,
      );
    }
    if (!sameExecutablePath(serverIdentity.executablePath, config.binary)) {
      throw new Error(
        `sdcpp port ${record.port} is held by pid ${record.pid}, whose executable ` +
          `"${serverIdentity.executablePath}" does not match configured binary "${config.binary}". ` +
          'Forge will not kill an unverified process; stop it manually or choose another port.',
      );
    }
    await deps.terminateProcess(record.pid);
    await waitForSdProcessExit(deps.lookupProcess, record.pid, record.pidCreatedAt, deps.now);
    await deleteSdServerRecord(deps.recordPath);
    return undefined;
  }
  if (ownerAlive && record.signature !== signature) {
    throw new Error(
      `sdcpp port ${record.port} is owned by another Forge window using model ` +
        `"${record.diffusionModel}". Stop that backend or configure another port/model.`,
    );
  }
  if (!ownerAlive) {
    throw new Error(
      `sdcpp port ${record.port} is held by pid ${record.pid}, but its owner/process identity ` +
        'cannot be verified. Stop it manually or choose another port.',
    );
  }
  if (!sameExecutablePath(serverIdentity.executablePath, config.binary)) {
    throw new Error(
      `sdcpp owner record for port ${record.port} names pid ${record.pid} at ` +
        `"${serverIdentity.executablePath}", not configured binary "${config.binary}".`,
    );
  }
  await verifySdServerAdoption(config, deps.baseUrl, deps.fetchImpl);
  return record;
}

/**
 * Prove a freshly spawned child is the server this config asked for, and build
 * the record that makes it reappable if this window dies. Every check runs
 * before the record is written: a record that names the wrong pid is worse than
 * no record, because the next window would kill that process.
 */
export async function createSdServerRecord(
  config: SdcppImageBackendConfig,
  child: ChildProcess,
  binary: string,
  signature: string,
  deps: SdProcessLookup & { ownerPid: number },
): Promise<SdServerOwnerRecord> {
  const pid = child.pid;
  if (!pid) throw new Error('sd-server spawn returned no pid.');
  const [serverIdentity, ownerIdentity] = await Promise.all([
    deps.lookupProcess(pid),
    deps.lookupProcess(deps.ownerPid),
  ]);
  if (!serverIdentity)
    throw new Error(`Get-CimInstance did not find spawned sd-server pid ${pid}.`);
  if (!sameExecutablePath(serverIdentity.executablePath, binary)) {
    throw new Error(
      `Spawned sd-server pid ${pid} resolves to "${serverIdentity.executablePath}", not binary "${binary}".`,
    );
  }
  if (!ownerIdentity) {
    throw new Error(
      `Get-CimInstance did not return creation time for Forge owner pid ${deps.ownerPid}.`,
    );
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`sd-server exited before its owner record could be written (pid ${pid}).`);
  }
  const timestamp = deps.now();
  return {
    pid,
    pidCreatedAt: serverIdentity.createdAt,
    port: config.port,
    binary,
    diffusionModel: config.diffusion_model,
    signature,
    ownerPid: deps.ownerPid,
    ownerCreatedAt: ownerIdentity.createdAt,
    startedAt: timestamp,
    lastUsedAt: timestamp,
  };
}
