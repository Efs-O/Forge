/**
 * The two modes of `/workspace <name>`, and everything one window does around
 * a switch it started: record the departure, open the target, undo it if nobody
 * claims, and claim a chat that arrived here.
 *
 * Two modes, because the old single behaviour destroyed work:
 * - `replace` reloads this window, so the phone's connection moves with it and
 *   every turn in the window dies. It is what has always happened, and stays
 *   the default for an idle switch.
 * - `new-window` opens the target in a **second** VS Code window and keeps this
 *   one alive — but this window still stops its transports and releases the
 *   lease, so the phone follows the new window instead of answering in two
 *   places at once.
 *
 * The lease decides which window serves the chat, so both claim paths take it
 * **before** touching the handoff record: a window that cannot have it says
 * nothing and leaves the record for whoever can.
 */
import * as path from 'path';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { getLogger } from '../util/logger';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteHandoffCoordinator } from './RemoteHandoffCoordinator';
import {
  TAKEOVER_CLAIM_DEADLINE_MS,
  TAKEOVER_RACE_DEADLINE_MS,
  type RemoteTransportManager,
} from './RemoteTransportManager';
import { RemoteLeaseError, RemoteTransportLease } from './RemoteTransportLease';
import { reservedForAnotherWorkspace } from './remoteReloadReservation';
import { currentWorkspaceIdentity, workspaceAliases } from './remoteControllerOptions';
import { preflightRemoteWorkspaceSwitch } from './remoteWorkspacePreflight';
import type { WorkspaceHandoff } from './RemoteStoreSchemas';
import type { WorkspaceSwitchModeChoice } from './types';
import {
  announceWorkspaceArrivals,
  recordWorkspaceHandoff,
  resumeWorkspaceHandoffs,
  workspaceIdFor,
} from './RemoteWorkspaceHandoff';

const log = getLogger();

/** The mode a switch runs in. `cancel` is the keyboard's third choice and never
 *  reaches this file: it means "do not switch at all". The definition lives in
 *  `types.ts`, because the command layer, the controller options and the runtime
 *  all name it. */
export type { WorkspaceSwitchModeChoice } from './types';

export interface RemoteWorkspaceSwitchDeps {
  config: ForgeConfig;
  alias: string;
  channel: string;
  chatId: string;
  /** `replace` reloads this window; `new-window` opens a second one and keeps
   *  this one alive, but stops its transports either way. */
  mode: WorkspaceSwitchModeChoice;
  workspaceId: string;
  workspaceRoot?: string;
  store: RemoteRequestStore;
  coordinator: RemoteHandoffCoordinator;
  stopTransports: () => Promise<void>;
  /** `forceNewWindow` is what makes `new-window` a second window instead of
   *  focusing one that already has the folder open. */
  openWorkspace: (directory: string, forceNewWindow: boolean) => Promise<void>;
}

/** Persists the handoff now, then returns the move to run after inbound disposition. */
export async function prepareRemoteWorkspaceSwitch(
  deps: RemoteWorkspaceSwitchDeps,
): Promise<() => Promise<void>> {
  const aliases = workspaceAliases(deps.config, deps.workspaceRoot);
  const target = aliases[deps.alias];
  if (!target) throw new Error(`workspace “${deps.alias}” was not found.`);
  const handoffId = await recordWorkspaceHandoff(
    deps.store,
    deps.workspaceId,
    target,
    deps.alias,
    deps.channel,
    deps.chatId,
    deps.mode,
  );
  const rollback = {
    handoffId,
    channel: deps.channel as 'telegram' | 'whatsapp',
    chatId: deps.chatId,
    mode: deps.mode,
    targetName: target.display_name,
    currentName:
      currentWorkspaceIdentity(aliases, deps.workspaceId, deps.workspaceRoot).name ??
      'this workspace',
  };
  return async () => {
    // openWorkspace kills this window in replace mode: nothing may still hold
    // the state lock. Stopping the transports releases the lease, which is what
    // lets the target window take it before it claims.
    await deps.store.drainMutations();
    await deps.stopTransports();
    await deps.store.drainMutations();
    // The target window's claim handles a reload; otherwise the coordinator's
    // rollback timer does, and its wait is chosen per mode there.
    deps.coordinator.armRollback(rollback);
    try {
      await deps.openWorkspace(target.path, deps.mode === 'new-window');
    } catch (err) {
      await deps.coordinator.rollbackNow(rollback);
      throw err;
    }
  };
}

/** The handoff machinery a running runtime needs, gathered once so the runtime
 *  itself stays a thin caller of the three functions below. */
export interface WorkspaceHandoffRuntimeDeps {
  store: RemoteRequestStore;
  manager: RemoteTransportManager;
  coordinator: RemoteHandoffCoordinator;
  workspaceId: string;
  /** The folder this window has open, for reading the alias map it will show. */
  workspaceRoot?: string;
  host: ForgeHostFacade;
  isDisposed: () => boolean;
  /** The config this window asked for, kept even when starting failed. */
  requestedConfig: () => ForgeConfig | undefined;
  /** True when this window is the one that should be answering the phone. */
  activeTransports: () => string[];
  /**
   * Says whether a record's receipt may be sent: `false` once this window has
   * already said the same thing about it, so a retry tick cannot spam the chat.
   * A failure is said once, and only a later success may replace it.
   */
  announceOnce: (handoffId: string, succeeded: boolean) => boolean;
  /** Enrolled TOTP means the arriving chat is locked, which the receipt has to
   *  say — sessions are memory-only and live in the window that authenticated
   *  them, so they never cross into the window taking the chat over. */
  totpEnrolled: (channel: WorkspaceHandoff['channel']) => Promise<boolean>;
  notifyLocal: (message: string) => void;
  /** Releases the lease by stopping every transport this window is running. */
  stopTransports: () => Promise<void>;
  /** Global storage, which is where a target window with no config of its own
   *  would look. */
  globalStoragePath: string;
  /**
   * Close **this** window, run by the window itself when its own 5 s watch reads
   * a close-request it agreed to (`workbench.action.closeWindow`). Absent means
   * there is no inbox: a window that cannot close itself must not accept a Close
   * it cannot carry out.
   */
  closeWindow?: (() => Promise<void>) | undefined;
  /** True while this window has editors with unsaved changes, which is why a
   *  phone Close is refused rather than attempted: the command would open a
   *  modal save prompt and leave the window open while the phone thinks it
   *  closed. */
  hasUnsavedEditors?: (() => boolean) | undefined;
  /** The user-scope `forge.configFile`, for the same preflight. */
  userConfigFileSetting?: (() => string | undefined) | undefined;
  openWorkspace?: ((directory: string, forceNewWindow: boolean) => Promise<void>) | undefined;
}

/**
 * Ask the target window's config before anything is recorded or opened: a
 * target that starts with remote off would take the phone and never answer it,
 * and the switch would look like a hang rather than a missing setting.
 */
export function switchWorkspacePreflight(
  deps: WorkspaceHandoffRuntimeDeps,
  request: { config: ForgeConfig; alias: string; channel: string },
): string | undefined {
  const target = workspaceAliases(request.config, deps.workspaceRoot)[request.alias];
  if (!target) return `workspace “${request.alias}” was not found.`;
  const outcome = preflightRemoteWorkspaceSwitch({
    targetPath: target.path,
    channel: request.channel === 'whatsapp' ? 'whatsapp' : 'telegram',
    globalStoragePath: deps.globalStoragePath,
    ...(deps.userConfigFileSetting ? { userConfigFileSetting: deps.userConfigFileSetting() } : {}),
  });
  return outcome.ok ? undefined : outcome.reason;
}

/**
 * Activation's lease take, with the one decision activation should not make on
 * its own: how long to wait, and whether a refusal is worth saying.
 *
 * It always waits `TAKEOVER_RACE_DEADLINE_MS`, whatever a pending record says,
 * because the long wait belongs to `RemoteWindowWatch`: that watch is started
 * before this runs, is cancelled by `dispose()`, and re-reads the record from
 * disk, so it stops retrying the moment the chat lands somewhere else. Nothing
 * but `dispose()` aborts a wait inside `takeOver`, and a window forced open onto
 * a folder another window already had used to hold the rest of `activate`
 * behind a 90 s lease contest (review of `784abad1`).
 *
 * A refusal **with a chat on its way** returns `true` instead of throwing: the
 * window holding the lease is answering this chat right now, so anything said
 * here would contradict it, and `remoteRuntimeSetup` would otherwise show
 * "Forge remote failed to start" for a switch that is working as planned. Every
 * other error, and a refusal with no chat waiting, still throws, because that
 * is the failure `replaceWithRetry` reports and `RemoteStartRetry` times.
 */
export async function takeTransportsForActivation(
  manager: RemoteTransportManager,
  config: ForgeConfig,
  opts: { waitingForAChat: boolean; signal?: AbortSignal },
): Promise<boolean> {
  try {
    await manager.takeOver(config, {
      deadlineMs: TAKEOVER_RACE_DEADLINE_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return false;
  } catch (err) {
    if (!opts.waitingForAChat || !(err instanceof RemoteLeaseError)) throw err;
    log.debug('[remote] activation lease held by another window; its watch will claim');
    return true;
  }
}

/** True when a live window already holds the lease for **every** transport this
 *  config would start, so this window could serve nothing even if it tried: the
 *  read-only peek that keeps a window which is merely not serving from rewriting
 *  the shared state every tick. `RemoteTransportManager.startTransport` calls
 *  `reconcileDeadClaims()` — a write to `remote-state-v2.json` — **before** it
 *  tries the lease, so an attempt that was always going to be refused would
 *  rewrite that file every 5 s forever, and every other window's coordinator poll
 *  is gated on its modified time, so each of them would re-read the whole state
 *  every tick too. That is the cost the plan's audit 3.3 refuses heartbeat writes
 *  for, arriving by a different route.
 *
 *  The folder and the key are the ones `startTransport` uses: `remote-leases`
 *  under this window's storage directory (`globalStoragePath` is that same value,
 *  handed here as `options.storageDirectory`), and the channel name. A channel
 *  that is off is not checked, and a config with no channel on has nothing to
 *  take, so it counts as held. `isHeld` is not a mutex (see its doc), so this
 *  never wins a lease for anyone: it only says an attempt would be a write for
 *  nothing.
 */
async function everyEnabledLeaseIsHeld(
  deps: WorkspaceHandoffRuntimeDeps,
  config: ForgeConfig,
): Promise<boolean> {
  const directory = path.join(deps.globalStoragePath, 'remote-leases');
  for (const channelName of ['telegram', 'whatsapp'] as const) {
    if (config.remote?.[channelName].enabled !== true) continue;
    if (await reservedForAnotherWorkspace(directory, channelName, deps.workspaceId)) continue;
    if (!(await RemoteTransportLease.isHeld({ directory, key: channelName }))) return false;
  }
  return true;
}

/**
 * Come back into service (plan phase 3, named by the review of `64562cb5`).
 *
 * A window that lost the lease race and whose handoff record went away had no
 * transports and no way back except a reload or a new switch, because
 * `RemoteStartRetry` has always answered a lease refusal with "another window
 * serves this chat" and never retried one. When the window that **was** serving
 * closes, its lease goes stale at the 20 s horizon and any window that is
 * **still trying** can take it — and only this window's own 5 s watch is still
 * trying, because the watch stops with the record and this is the one timer a
 * window keeps whatever a switch or a claim did to the others. The watch does
 * not call this while it is waiting for a window it asked to be opened
 * (`WindowWatchDeps.waitingForTargetWindow`), so a `new-window` target keeps its
 * whole claim window instead of having the phone taken back a tick after it was
 * promised.
 *
 * It goes through `takeTransportsForActivation`, so a `RemoteLeaseError` is
 * swallowed here: a window whose lease is live elsewhere is not serving and is
 * not wrong, and reporting it every tick is the log spam the plan's second pass
 * asks to avoid — nothing reaches the phone either way. It asks `FileLease.isHeld`
 * first (`everyEnabledLeaseIsHeld`), so the ordinary case — a live window signing
 * its lease — returns before any lease attempt, and therefore before
 * `startTransport`'s `reconcileDeadClaims` write: a window that is merely waiting
 * writes nothing, logs nothing and says nothing every tick. `dispose()` aborts the
 * wait, and `TAKEOVER_RACE_DEADLINE_MS` bounds an attempt that does run to one
 * retry, so a tick that gets nothing costs two seconds and starts nothing.
 */
export async function comeBackIntoService(
  deps: WorkspaceHandoffRuntimeDeps,
  opts: { signal: AbortSignal },
): Promise<void> {
  const config = deps.requestedConfig();
  if (deps.isDisposed() || config?.remote?.enabled !== true) return;
  if (deps.activeTransports().length > 0) return;
  // The zero-write steady state: while another window is signing its lease this
  // tick touches nothing — no lease attempt, no state write, no log line.
  if (await everyEnabledLeaseIsHeld(deps, config)) return;
  try {
    await takeTransportsForActivation(deps.manager, config, {
      waitingForAChat: false,
      signal: opts.signal,
    });
  } catch (err) {
    // Including an abort that landed mid-retry: `takeOver` reports the last
    // lease refusal, and this window has nothing to say about either. Nothing is
    // logged either, not even at debug level: a window that is not serving while
    // another one answers the phone is the normal steady state of a two-window
    // setup, and this is the timer that runs forever inside it, so a line per
    // tick is the same kind of churn the plan's audit 3.3 refuses heartbeat
    // writes for. A failure that is **not** a lease refusal still throws, and
    // the watch says it once.
    if (err instanceof RemoteLeaseError) return;
    throw err;
  }
}

/**
 * A handoff addressed here, claimed by this window.
 *
 * The lease is taken **before** the record is claimed — it is the only
 * cross-process mutex there is, so letting it decide keeps two windows on the
 * same folder from both binding the chat, and leaves the record pending for the
 * source window to take back when this window cannot serve it at all. A window
 * that cannot have the lease says nothing: the window that does have it is
 * answering this chat right now, and a second receipt would contradict it.
 *
 * Runs inside the lifecycle chain (the coordinator serializes it), so it must
 * not enqueue again.
 */
export async function claimWorkspaceArrivals(
  deps: WorkspaceHandoffRuntimeDeps,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const config = deps.requestedConfig();
  if (deps.isDisposed() || config?.remote?.enabled !== true) return;
  try {
    await deps.manager.takeOver(config, {
      deadlineMs: TAKEOVER_CLAIM_DEADLINE_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    // A lease refusal is not a failure to report: another window is serving
    // this chat on the phone right now, and `RemoteWindowWatch` retries this
    // claim every tick while a record is still pending here.
    if (err instanceof RemoteLeaseError) {
      log.debug(`[remote] handoff claim deferred: ${err.message}`);
      return;
    }
    throw err;
  }
  if (deps.activeTransports().length === 0) return;
  const arrivals = await resumeWorkspaceHandoffs(deps.store, deps.workspaceId, deps.host);
  // Only the records this window has not already spoken about: a binding write
  // that throws leaves the record pending, the watch retries it every tick, and
  // without this gate the chat would get the same "could not be bound here"
  // receipt every five seconds until the record's TTL prunes it.
  const toAnnounce = arrivals.filter((arrival) =>
    deps.announceOnce(arrival.handoff.id, !arrival.failure && !arrival.bindingFailure),
  );
  if (toAnnounce.length === 0) return;
  const aliases = workspaceAliases(config, deps.workspaceRoot);
  await announceWorkspaceArrivals(toAnnounce, {
    channelFor: (name) => deps.manager.get(name)?.channel,
    displayNameFor: (alias) => aliases[alias]?.display_name ?? alias,
    displayNameForWorkspaceId: (id) =>
      Object.values(aliases).find((entry) => workspaceIdFor(entry.path) === id)?.display_name,
    totpEnrolled: deps.totpEnrolled,
    notifyLocal: deps.notifyLocal,
  });
}

/**
 * The receipts this window has sent, kept in one gate per runtime. A runtime
 * lives as long as the window, which is exactly the scope the rule needs: after
 * a reload the window may legitimately say it again, and a second window must
 * not be silenced by the first one's memory.
 */
export function createAnnounceGate(): (handoffId: string, succeeded: boolean) => boolean {
  const sent = new Map<string, boolean>();
  return (handoffId, succeeded) => {
    const seen = sent.get(handoffId);
    if (seen === undefined) {
      sent.set(handoffId, succeeded);
      return true;
    }
    // A success after a failure is new information and is worth saying; a
    // repeat of the same kind of answer is not.
    if (!seen && succeeded) {
      sent.set(handoffId, true);
      return true;
    }
    return false;
  };
}

/**
 * The move itself, called by the runtime: the same durable record, the same
 * rollback machinery, and the mode that decides whether this window reloads or
 * a second window is opened beside it.
 */
export async function switchRemoteWorkspace(
  deps: WorkspaceHandoffRuntimeDeps,
  request: {
    config: ForgeConfig;
    alias: string;
    channel: string;
    chatId: string;
    mode: WorkspaceSwitchModeChoice;
  },
): Promise<() => Promise<void>> {
  const openWorkspace = deps.openWorkspace;
  if (!openWorkspace) throw new Error('workspace switching is unavailable in this window.');
  return prepareRemoteWorkspaceSwitch({
    ...request,
    workspaceId: deps.workspaceId,
    ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
    store: deps.store,
    coordinator: deps.coordinator,
    stopTransports: deps.stopTransports,
    openWorkspace,
  });
}

/**
 * Brings this window's transports back, which is the whole of undoing a switch
 * that never happened: taking the lease is what makes it safe to tell the chat
 * "you are still here". `false` means another window holds it and is serving,
 * so this window leaves the record alone and says nothing.
 */
export async function takeTransportsForRollback(
  deps: WorkspaceHandoffRuntimeDeps,
): Promise<boolean> {
  const config = deps.requestedConfig();
  if (deps.isDisposed() || !config || config.remote?.enabled !== true) return false;
  try {
    // The short deadline: a rollback that has to wait 90 s for a lease is a
    // rollback whose window is already answering the phone some other way.
    await deps.manager.takeOver(config, { deadlineMs: TAKEOVER_RACE_DEADLINE_MS });
  } catch (err) {
    if (err instanceof RemoteLeaseError) {
      log.debug(`[remote] rollback deferred: ${err.message}`);
      return false;
    }
    throw err;
  }
  return deps.activeTransports().length > 0;
}

/** Give back a lease a rollback grabbed but will not use. */
export async function releaseTransportsAfterRollback(
  deps: WorkspaceHandoffRuntimeDeps,
): Promise<void> {
  await deps.stopTransports();
}
