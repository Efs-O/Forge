import type { ForgeConfig } from '../config/types';
import { RemoteHandoffCoordinator } from './RemoteHandoffCoordinator';
import {
  claimWorkspaceArrivals,
  createAnnounceGate,
  releaseTransportsAfterRollback,
  takeTransportsForRollback,
  type WorkspaceHandoffRuntimeDeps,
} from './remoteWorkspaceSwitch';
import { createRemoteWindowWatch, type RemoteWindowWatch } from './RemoteWindowWatch';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteTransportManager } from './RemoteTransportManager';
import type { RemoteRuntimeOptions } from './types';

/**
 * The runtime's workspace-handoff wiring, built once: the arrival coordinator,
 * the bundle `remoteWorkspaceSwitch.ts` calls `WorkspaceHandoffRuntimeDeps`, and
 * this window's own 5 s watch.
 *
 * Assembling those three is the handoff subsystem's concern, not the transport
 * lifecycle's, so it lives here next to the modules it wires instead of in
 * `RemoteRuntime.ts`, which is at the ESLint `max-lines` stop: every change to
 * this assembly (`announceOnce`, the rollback's `takeTransportsForRollback`, the
 * watch tick) had to buy its room by cutting something unrelated there.
 */
export interface RemoteRuntimeHandoffInput {
  /** Read for `workspaceId`, `host`, `storageDirectory`, `notifyLocal`,
   *  `userConfigFileSetting`, `handoffWatch` and the optional window actions. */
  options: RemoteRuntimeOptions;
  /** The runtime's state file, already joined for the store it hands over. */
  storePath: string;
  store: RemoteRequestStore;
  manager: RemoteTransportManager;
  auth: RemoteAuth;
  /** Runs a task on the runtime's lifecycle chain. */
  serialize: <Task>(task: () => Promise<Task>) => Promise<Task>;
  /** Live read, not a snapshot: the runtime flips it while this bundle is held. */
  isDisposed: () => boolean;
  /** Live read: the config this window asked for, kept even when starting failed. */
  requestedConfig: () => ForgeConfig | undefined;
}

export interface RemoteRuntimeHandoffBundle {
  coordinator: RemoteHandoffCoordinator;
  handoff: WorkspaceHandoffRuntimeDeps;
  windowWatch: RemoteWindowWatch;
}

export function buildRemoteRuntimeHandoff(
  input: RemoteRuntimeHandoffInput,
): RemoteRuntimeHandoffBundle {
  const { options, storePath, store, manager, auth, serialize, isDisposed, requestedConfig } =
    input;
  const coordinator = new RemoteHandoffCoordinator({
    store,
    storePath,
    workspaceId: options.workspaceId,
    serialize: (task) => serialize(task),
    claimArrivals: () => claimWorkspaceArrivals(handoff),
    takeTransports: () => takeTransportsForRollback(handoff),
    releaseTransports: () => releaseTransportsAfterRollback(handoff),
    sendToChat: (channel, chatId, text) =>
      manager
        .get(channel)
        ?.channel.send(chatId, text)
        .then(() => undefined) ?? Promise.resolve(),
    notifyLocal: options.notifyLocal,
    ...(options.handoffWatch ?? {}),
  });
  const handoff: WorkspaceHandoffRuntimeDeps = {
    store,
    manager,
    coordinator,
    workspaceId: options.workspaceId,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    host: options.host,
    isDisposed: () => isDisposed(),
    requestedConfig: () => requestedConfig(),
    activeTransports: () => manager.names(),
    announceOnce: createAnnounceGate(),
    totpEnrolled: (channel) => auth.totpEnrolled(channel),
    notifyLocal: options.notifyLocal,
    stopTransports: () => manager.stopActive(),
    globalStoragePath: options.storageDirectory,
    userConfigFileSetting: () => options.userConfigFileSetting?.() ?? undefined,
    ...(options.openWorkspace ? { openWorkspace: options.openWorkspace } : {}),
    ...(options.closeWindow ? { closeWindow: options.closeWindow } : {}),
    ...(options.hasUnsavedEditors ? { hasUnsavedEditors: options.hasUnsavedEditors } : {}),
  };
  // The whole watch, deps included, is built in `RemoteWindowWatch.ts`: the
  // runtime's file was at the ESLint line stop and the plan said the room for
  // phase 3 had to come from extracting the runtime's bodies, not from
  // widening them. That room came from here — the runtime hands its wiring over.
  const windowWatch = createRemoteWindowWatch({
    handoff,
    // Through the lifecycle chain, or a retry could interleave a second
    // `startAll` over the active map and leak a lease.
    serialize: (task) => serialize(task),
    ...(options.handoffWatch?.pollIntervalMs
      ? { tickIntervalMs: options.handoffWatch.pollIntervalMs }
      : {}),
  });
  return { coordinator, handoff, windowWatch };
}
