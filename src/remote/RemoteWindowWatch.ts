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
 * a window has exactly one watch to dispose of.
 *
 * Single-flight on purpose: `takeOver` now runs past the 20 s stale horizon, so
 * 5 s ticks would otherwise stack overlapping retry loops inside one window.
 */

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
  isDisposed: () => boolean;
  notifyLocal: (message: string) => void;
}

const TICK_INTERVAL_MS = 5_000;

export class RemoteWindowWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** One disk read at a time, so a 90 s retry does not pile a fresh read on top
   *  of an unread one every tick — the same reason the coordinator's poll is
   *  gated on the state file's modified time. */
  private checking = false;
  private abort: AbortController | undefined;

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
  }

  private async tick(): Promise<void> {
    if (this.deps.isDisposed()) return;
    if (this.running) {
      // The record was completed by another window or expired while this
      // window's 90 s lease retry was still looping: a retry that runs on to
      // the deadline would start transports this window has no chat for, and it
      // holds the lifecycle chain the whole time. Cancel it instead — after
      // reading the record from disk, because this window's only other refresh
      // is the one the retry is blocking.
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
    // Nothing waiting, or already serving: no work, and no lease churn.
    if (!this.deps.handoffPending() || this.deps.serving()) return;
    this.running = true;
    const abort = new AbortController() as WatchAbort;
    this.abort = abort;
    try {
      await this.deps.retryClaim(abort.signal);
    } catch (err) {
      // A lease refusal is expected and silent (see `claimWorkspaceArrivals`);
      // a cancelled retry is silent too, because nothing was wrong with this
      // window — the chat simply went somewhere else. Anything else is worth
      // saying once, because the next tick will try again and a stuck claim
      // must not be invisible.
      if (!abort.droppedForNoHandoff)
        this.deps.notifyLocal(
          `Forge remote could not claim an arriving chat: ${(err as Error).message}`,
        );
    } finally {
      this.running = false;
      if (this.abort === abort) this.abort = undefined;
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

/** The watch's own controller, with the one fact its catch needs afterwards. */
type WatchAbort = AbortController & { droppedForNoHandoff?: boolean };
