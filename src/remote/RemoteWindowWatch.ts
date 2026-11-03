/**
 * This window's own 5 s watch — the timer that keeps a window honest about a
 * handoff it was meant to serve.
 *
 * The coordinator's poll fires only when the shared state file's modified time
 * changes (`RemoteHandoffCoordinator.ts`), so a window that lost the lease race
 * once would never look again: releasing a lease does not touch that file. This
 * watch is per window rather than per state file, and it re-attempts the lease
 * take and the claim while a handoff addressed to this workspace is still
 * pending and this window is not serving the phone.
 *
 * It arrives with phase 2 of `docs/plans/TELEGRAM_WORKSPACE_SWITCH_SAFETY_PLAN.md`
 * because phase 2 depends on it: without it a window that cannot get the lease
 * at activation leaves its chat silent until somebody reloads. Phase 3 adds the
 * `remote-windows/<windowId>.close-request.json` read to this same interval, so
 * a window has exactly one watch to dispose of, and the close-result read the
 * serving window owes the phone rides on the same tick.
 *
 * Phase 3's come-back rides on the same tick: when nothing was handed to this
 * window and it is not serving, the watch tries to take the transports back, in
 * case the window that was answering the phone closed and nobody else is still
 * trying. It says nothing while it is waiting for a window it asked to be
 * opened, so a switch's target keeps its whole claim window.
 *
 * Single-flight on purpose: `takeOver` now runs past the 20 s stale horizon, so
 * 5 s ticks would otherwise stack overlapping retry loops inside one window.
 */
import { globalBusyReason } from './remoteCommandShared';
import { windowDirectory } from './RemoteWindowRegistry';
import { reportCloseResults, runWindowClose } from './RemoteWindowClose';
import { currentWorkspaceIdentity, workspaceAliases } from './remoteControllerOptions';
import {
  claimWorkspaceArrivals,
  comeBackIntoService,
  type WorkspaceHandoffRuntimeDeps,
} from './remoteWorkspaceSwitch';

export interface WindowWatchDeps {
  tickIntervalMs?: number;
  /** True while a handoff addressed to this window has not expired, read from
   *  this window's **in-memory** copy of the shared state: cheap, and fresh
   *  enough between attempts because the coordinator's poll keeps it current
   *  whenever this window is not busy. */
  handoffPending: () => boolean;
  /** Pull the shared state from disk before `handoffPending()` is trusted while
   *  an attempt is in flight. It has to come from disk there and nowhere else:
   *  the attempt holds the lifecycle chain, and the coordinator's
   *  `store.refresh()` sits **inside** that chain, so during a 90 s lease retry
   *  nothing else updates this window's copy and the cancel below would never
   *  see the record go away. Goes through the store's own write tail, which the
   *  retry is not holding — that is the whole point of asking for it separately. */
  refreshHandoff: () => Promise<void>;
  /** True when this window is serving the phone, so a retry would be wrong. */
  serving: () => boolean;
  /** Take the lease and claim what arrived. `signal` is aborted by `dispose()`,
   *  so a window that is going away stops mid-retry instead of finishing it. */
  retryClaim: (signal: AbortSignal) => Promise<void>;
  /** Nothing was handed here and this window is not serving, so try to take
   *  the transports back anyway: the window that was answering the phone may
   *  have closed, and this is the only timer still trying. A lease refusal is
   *  silent inside `comeBackIntoService`, so a window that is merely waiting
   *  for the lease says nothing every tick. */
  comeBack: (signal: AbortSignal) => Promise<void>;
  /** True while this window is waiting for a window **it** asked to be opened
   *  to claim a chat: an armed rollback from its own `new-window` switch. That
   *  switch stopped its transports and released the lease on purpose, and the
   *  target gets the whole claim window (`NEW_WINDOW_ROLLBACK_MS`, 73 s
   *  open→activation measured in phase 0) before this window may undo it, so a
   *  come-back here would take the free lease one tick after the switch, leave
   *  the cold target unable to get the phone at all, and report "could not
   *  switch" for a move that would have worked. Only the come-back is gated: a
   *  record addressed **here** is this window's own business, and the switch is
   *  addressed to another window. The rollback clears itself — it fires, or the
   *  target claims and this window's attempts are refused by a live lease — so
   *  the gate cannot outlive the switch it belongs to. */
  waitingForTargetWindow: () => boolean;
  isDisposed: () => boolean;
  notifyLocal: (message: string) => void;
  /**
   * Read this window's own `remote-windows/<windowId>.close-request.json` and act
   * on what it finds: the window decides for itself and closes itself, or refuses
   * and writes the refusal. Optional — a window with no phone surface has no
   * inbox, and a window that cannot close itself must not pretend otherwise.
   *
   * It runs ahead of the claim slot on purpose: a window the phone just asked to
   * close must not wait out another window's 90 s lease retry to answer, and the
   * close decision takes no lease at all.
   */
  readCloseRequest?: (signal: AbortSignal) => Promise<void>;
  /** Report close outcomes to the chats that asked, and only while serving: a
   *  window that is not serving cannot message the phone, which is why the
   *  outcome is a file instead of a send. Cleared by the same `dispose()` as the
   *  close-request read, because it is the same timer. */
  reportCloseResults?: (signal: AbortSignal) => Promise<void>;
}

const TICK_INTERVAL_MS = 5_000;

export class RemoteWindowWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** One disk read at a time, so a 90 s retry does not pile a fresh read on top
   *  of an unread one every tick — the same reason the coordinator's poll is
   *  gated on the state file's modified time. */
  private checking = false;
  /** What has already been put on the owner's screen. `notifyLocal` is an error
   *  toast, and a watch that never stops ticking would repeat the same one every
   *  five seconds for as long as the window is open — which is what a transport
   *  that cannot start at all (a missing token) does. A *different* message is
   *  new information and is still said. */
  private readonly reported = new Set<string>();
  private abort: WatchAbort | undefined;
  /** One inbox read at a time. It has its own slot because the claim retry holds
   *  its own for up to 90 s, and a close request must not queue behind it. */
  private readingClose = false;
  private closeAbort: AbortController | undefined;
  /** Inbox failures follow the same once-per-message rule as the claim failures:
   *  kept apart so the clear-on-serving below stays about the lease failures it
   *  was written for. */
  private readonly inboxReported = new Set<string>();

  constructor(private readonly deps: WindowWatchDeps) {}

  /** Idempotent: a config reload restarts transports, not this watch. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickIntervalMs ?? TICK_INTERVAL_MS);
  }

  /** Clears the interval **and** cancels an in-flight attempt, so nothing keeps
   *  waiting on a window that is shutting down. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.abort = undefined;
    this.closeAbort?.abort();
    this.closeAbort = undefined;
  }

  private async tick(): Promise<void> {
    if (this.deps.isDisposed()) return;
    // The inbox first, and outside the claim slot: a window the phone asked to
    // close must not wait out a 90 s lease retry to answer, and the close
    // decision takes no lease. Its failures are reported the same once-per-message
    // way as everything else this timer does forever.
    await this.inbox();
    if (this.deps.isDisposed()) return;
    if (this.running) {
      // The record was completed by another window or expired while this
      // window's 90 s lease retry was still looping: a retry that runs on to
      // the deadline would start transports this window has no chat for, and it
      // holds the lifecycle chain the whole time. Cancel it instead — after
      // reading the record from disk, because this window's only other refresh
      // is the one the retry is blocking. A come-back attempt has no record to
      // go away, so it is not read for one and not cancelled by its absence:
      // it ends by getting the lease, by its own 2 s deadline, or by `dispose()`.
      if (this.abort?.kind !== 'claim') return;
      if (this.checking) return;
      this.checking = true;
      try {
        await this.deps.refreshHandoff();
      } catch {
        // A state file this window cannot read at this moment says nothing
        // about the record, so it is not a reason to stop a running attempt.
      } finally {
        this.checking = false;
      }
      if (!this.deps.handoffPending()) this.drop(this.abort);
      return;
    }
    // Already serving: no work, and no lease churn. A window that is answering
    // the phone has nothing left to warn about, so what it said while it was not
    // is stale: clear it, or a failure that came back after a recovery could be
    // silenced for the rest of the window's life.
    if (this.deps.serving()) {
      this.reported.clear();
      return;
    }
    const claim = this.deps.handoffPending();
    // This window ran a switch and is waiting for the window it opened to claim
    // the chat: out of service on purpose, and the rollback — not this watch —
    // owns what happens next. No lease work, no disk read, nothing said.
    if (!claim && this.deps.waitingForTargetWindow()) return;
    this.running = true;
    const abort = new AbortController() as WatchAbort;
    abort.kind = claim ? 'claim' : 'comeBack';
    this.abort = abort;
    try {
      await (claim ? this.deps.retryClaim(abort.signal) : this.deps.comeBack(abort.signal));
    } catch (err) {
      // A lease refusal is expected and silent (see `claimWorkspaceArrivals`);
      // a cancelled retry is silent too, because nothing was wrong with this
      // window — the chat simply went somewhere else. Anything else is worth
      // saying once, because the next tick will try again and a stuck claim
      // must not be invisible.
      const failure = claim
        ? `Forge remote could not claim an arriving chat: ${(err as Error).message}`
        : `Forge remote could not come back into service: ${(err as Error).message}`;
      if (!abort.droppedForNoHandoff && !this.reported.has(failure)) {
        this.reported.add(failure);
        this.deps.notifyLocal(failure);
      }
    } finally {
      this.running = false;
      if (this.abort === abort) this.abort = undefined;
    }
  }

  /** The close inbox, and the outcomes this window has to carry for windows that
   *  could not message the phone themselves. */
  private async inbox(): Promise<void> {
    const reading = this.deps.readCloseRequest;
    const reporting = this.deps.reportCloseResults;
    if (!reading && !reporting) return;
    if (this.readingClose) return;
    this.readingClose = true;
    const abort = new AbortController();
    this.closeAbort = abort;
    try {
      if (reading) await reading(abort.signal);
      // Only while serving: the window that holds the lease is the only one that
      // can reach the phone, which is why the outcome is a file at all.
      if (reporting && this.deps.serving()) await reporting(abort.signal);
    } catch (err) {
      const failure = `Forge remote could not act on a window request: ${(err as Error).message}`;
      if (!this.inboxReported.has(failure)) {
        this.inboxReported.add(failure);
        this.deps.notifyLocal(failure);
      }
    } finally {
      this.readingClose = false;
      if (this.closeAbort === abort) this.closeAbort = undefined;
    }
  }

  /** Cancel an in-flight attempt and mark why, so its failure is not reported
   *  as one. */
  private drop(abort: WatchAbort | undefined): void {
    if (!abort || abort.droppedForNoHandoff) return;
    abort.droppedForNoHandoff = true;
    abort.abort();
  }
}

/** The watch's own controller, with the two facts its catch needs afterwards:
 *  which attempt this is (only a claim may be cancelled by its record going
 *  away) and whether it was cancelled for that reason (so its failure is not
 *  reported as one). */
type WatchAbort = AbortController & {
  kind?: 'claim' | 'comeBack';
  droppedForNoHandoff?: boolean;
};

/**
 * The watch a running runtime keeps, built from the handoff bundle it already
 * owns. It lives here rather than in `RemoteRuntime.ts` because that file is at
 * the ESLint `max-lines` stop (`docs/OWNERS.md` names it the owner of transport
 * lifecycle, and the plan says the room for phase 3 has to come from extraction,
 * not from cramming): what is left in the runtime is one call and the two window
 * actions only VS Code can supply.
 */
export interface RemoteWindowWatchInput {
  /** The runtime's handoff bundle: it carries the store, the manager, the
   *  coordinator, the lease facts, and the two injected window actions
   *  (`closeWindow`, `hasUnsavedEditors`) this watch needs. */
  handoff: WorkspaceHandoffRuntimeDeps;
  /** The runtime's lifecycle chain. A retry that ran alongside a `startAll`
   *  would interleave a second one over the active map and leak a lease. */
  serialize: <Task>(task: () => Promise<Task>) => Promise<Task>;
  tickIntervalMs?: number;
}

export function createRemoteWindowWatch(input: RemoteWindowWatchInput): RemoteWindowWatch {
  const handoff = input.handoff;
  const directory = windowDirectory(handoff.globalStoragePath);
  const serving = () => handoff.activeTransports().length > 0;
  // The window's display name, computed once: `currentWorkspaceIdentity` hashes
  // every alias path, and hashing asks the filesystem for its canonical spelling,
  // so an unmemoised call would be a sync read every 5 s in every window.
  let name: string | undefined;
  const windowName = (): string => {
    if (name === undefined) {
      const config = handoff.requestedConfig();
      name = config
        ? (currentWorkspaceIdentity(
            workspaceAliases(config, handoff.workspaceRoot),
            handoff.workspaceId,
            handoff.workspaceRoot,
          ).name ?? 'a Forge window')
        : 'a Forge window';
    }
    return name;
  };
  // A window that cannot close itself has no inbox at all: wiring one anyway
  // would let it accept a Close, refuse nothing and write a success it did not
  // deliver. Held in a local because narrowing a property of a parameter inside
  // the arrow below is what the type checker cannot do on its own.
  const closeWindow = handoff.closeWindow;
  const inbox = closeWindow
    ? {
        readCloseRequest: (signal: AbortSignal) =>
          runWindowClose({
            directory,
            windowName: windowName(),
            signal,
            holdsLease: serving,
            ...(handoff.hasUnsavedEditors ? { hasUnsavedEditors: handoff.hasUnsavedEditors } : {}),
            // The same gate `/unload` and a `replace` switch use, so a phone Close
            // refuses on the same facts the owner's own commands refuse on.
            busyReason: () => globalBusyReason({ host: handoff.host, store: handoff.store }),
            closeWindow,
            notifyLocal: handoff.notifyLocal,
          }).then(() => undefined),
      }
    : {};
  return new RemoteWindowWatch({
    ...(input.tickIntervalMs ? { tickIntervalMs: input.tickIntervalMs } : {}),
    handoffPending: () => handoff.store.hasPendingWorkspaceHandoff(handoff.workspaceId),
    // From disk, not from this window's copy — see `WindowWatchDeps.refreshHandoff`.
    refreshHandoff: () => handoff.store.refresh(),
    serving,
    retryClaim: (signal) => input.serialize(() => claimWorkspaceArrivals(handoff, { signal })),
    // Phase 3: the same path activation takes, so a lease refusal here is as
    // silent as it is there. Without it a window left out of service by a switch
    // it did not win has no way back except a reload.
    comeBack: (signal) => input.serialize(() => comeBackIntoService(handoff, { signal })),
    // Its own armed rollback: a window waiting for the window it opened must not
    // take the phone back out from under it.
    waitingForTargetWindow: () => handoff.coordinator.isRollbackArmed(),
    isDisposed: () => handoff.isDisposed(),
    notifyLocal: handoff.notifyLocal,
    ...inbox,
    // The same timer as the close-request read, and cleared by the same `dispose()`.
    reportCloseResults: (signal) =>
      reportCloseResults({
        directory,
        // The death proof a `closed` report waits for is the real host check, the
        // one every other reader of this folder uses: that a window is really gone
        // is a fact about the machine, not something this window can guess, and a
        // test injects its own answer instead.
        send: async (channel, chatId, text) => {
          // An aborted watch is not a window that can still message anybody.
          if (signal.aborted) throw new Error('this window is closing');
          const transport =
            channel === 'whatsapp'
              ? handoff.manager.get('whatsapp')
              : handoff.manager.get('telegram');
          if (!transport) throw new Error(`no ${channel} transport to report on`);
          await transport.channel.send(chatId, text);
        },
      }).then(() => undefined),
  });
}
