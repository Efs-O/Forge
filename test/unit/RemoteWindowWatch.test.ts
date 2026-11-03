/**
 * The window's own 5 s watch: the only thing that re-tries a claim the lease
 * refused. The coordinator's poll fires on the state file's modified time, and
 * releasing a lease does not touch that file, so without this a window that
 * lost the lease race once would never serve the chat handed to it.
 *
 * Phase 2 of `docs/plans/TELEGRAM_WORKSPACE_SWITCH_SAFETY_PLAN.md`, and the
 * criteria that matter here are the two this repo asks of every new wait: what
 * cancels it, and does one attempt stack on the next.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { RemoteWindowWatch } from '../../src/remote/RemoteWindowWatch';

const TICK_MS = 20;
/** Comfortable margin over two ticks, so the assertions are about behaviour and
 *  not about how fast the machine happens to be. */
const SETTLE_MS = 200;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function watchFixture(overrides: Partial<Parameters<typeof RemoteWindowWatch>[0]> = {}) {
  const pending = { value: true };
  const serving = { value: false };
  const disposed = { value: false };
  const notified: string[] = [];
  const refreshes = { count: 0 };
  const claims: AbortSignal[] = [];
  const comeBacks: AbortSignal[] = [];
  const waitingForTargetWindow = { value: false };
  const watch = new RemoteWindowWatch({
    tickIntervalMs: TICK_MS,
    handoffPending: () => pending.value,
    refreshHandoff: async () => {
      refreshes.count += 1;
    },
    serving: () => serving.value,
    waitingForTargetWindow: () => waitingForTargetWindow.value,
    retryClaim: async (signal) => {
      claims.push(signal);
    },
    comeBack: async (signal) => {
      comeBacks.push(signal);
    },
    isDisposed: () => disposed.value,
    notifyLocal: (message) => notified.push(message),
    ...overrides,
  });
  return {
    watch,
    pending,
    serving,
    disposed,
    notified,
    refreshes,
    claims,
    comeBacks,
    waitingForTargetWindow,
  };
}

describe('RemoteWindowWatch', { timeout: 30_000 }, () => {
  it('retries the claim while a handoff is pending and this window is not serving', async () => {
    const calls: AbortSignal[] = [];
    const fixture = watchFixture({
      retryClaim: async (signal) => {
        calls.push(signal);
      },
    });
    fixture.watch.start();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toBeInstanceOf(AbortSignal);
    fixture.watch.dispose();
  });

  it('does not retry a claim when nothing is waiting, and does nothing when this window already serves', async () => {
    const calls: AbortSignal[] = [];
    const fixture = watchFixture({
      retryClaim: async (signal) => {
        calls.push(signal);
      },
    });
    fixture.pending.value = false;
    fixture.watch.start();
    // A generous budget, not a weaker claim: under a loaded full-suite run this
    // window's 20 ms tick can lag by seconds, and a come-back that has not
    // started yet is indistinguishable from one that never will.
    await vi.waitFor(() => expect(fixture.comeBacks.length).toBeGreaterThan(0), {
      timeout: 5_000,
    });
    // Nothing was handed here, so no claim retry — but the window is not
    // serving either, and phase 3 makes that a reason to try the transports
    // back on its own account, so the come-back is what runs instead.
    expect(calls).toHaveLength(0);

    fixture.pending.value = true;
    fixture.serving.value = true;
    const comeBacksSoFar = fixture.comeBacks.length;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(calls).toHaveLength(0);
    // Serving is the whole reason the watch exists to begin with: a window that
    // is answering the phone takes no lease and starts nothing.
    expect(fixture.comeBacks).toHaveLength(comeBacksSoFar);
    fixture.watch.dispose();
  });

  /**
   * `takeOver` now runs past the 20 s stale horizon, so without this guard the
   * 5 s ticks would stack a retry loop on top of another retry loop in the same
   * window — and each of them starts transports.
   */
  it('skips a tick while an attempt is still running', async () => {
    const held = deferred();
    let running = false;
    const calls: AbortSignal[] = [];
    const fixture = watchFixture({
      retryClaim: async (signal) => {
        calls.push(signal);
        if (running) throw new Error('two attempts running at once');
        running = true;
        await held.promise;
        running = false;
      },
    });
    fixture.watch.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    // Many ticks pass while the first attempt is still in flight: exactly one
    // attempt may be in flight, so the count must not grow and nothing may
    // report the guard firing.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(calls).toHaveLength(1);
    expect(fixture.notified).toEqual([]);
    // The cancel path stays alive during an attempt: a tick that could not ask
    // whether the record is still there would have to wait for the attempt to
    // end, which is how a 90 s retry used to run on past its own chat.
    expect(fixture.refreshes.count).toBeGreaterThan(0);
    held.resolve();
    // The watch resumes on the next tick rather than staying blocked: a claim
    // that failed once has to be retried, or the chat is silent for good.
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(1));
    expect(fixture.notified).toEqual([]);
    fixture.watch.dispose();
  });

  /** The plan's first question: what cancels the wait, and is that tested? */
  it('dispose clears the interval and aborts the attempt in flight', async () => {
    const held = deferred();
    const calls: AbortSignal[] = [];
    const fixture = watchFixture({
      retryClaim: async (signal) => {
        calls.push(signal);
        await held.promise;
      },
    });
    fixture.watch.start();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    fixture.watch.dispose();
    expect(calls[0]?.aborted).toBe(true);
    held.resolve();
    // Nothing is left to tick: a window that is shutting down must not start
    // transports after it has stopped them.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(calls).toHaveLength(1);
  });

  /**
   * The other half of "what cancels the wait": the record going away is as
   * good a reason to stop as the window going away. A 90 s lease retry that
   * runs on after another window completed the claim would start transports
   * this window has no chat for, and it holds the lifecycle chain the whole
   * time.
   */
  it('cancels an in-flight retry once nothing is pending any more', async () => {
    const signals: AbortSignal[] = [];
    const fixture = watchFixture({
      retryClaim: (signal) =>
        new Promise<void>((resolve) => {
          signals.push(signal);
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    fixture.watch.start();
    await vi.waitFor(() => expect(signals.length).toBe(1));
    expect(signals[0]?.aborted).toBe(false);
    fixture.pending.value = false;
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true), { timeout: 2_000 });
    // Silent: nothing went wrong with this window, the chat simply went
    // somewhere else, so the cancelled attempt must not report a failure.
    expect(fixture.notified).toEqual([]);
    fixture.watch.dispose();
  });

  it('reports a failed attempt once and keeps retrying', async () => {
    let attempt = 0;
    const fixture = watchFixture({
      retryClaim: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('state file is unreadable');
      },
    });
    fixture.watch.start();
    await vi.waitFor(() =>
      expect(fixture.notified).toEqual([
        'Forge remote could not claim an arriving chat: state file is unreadable',
      ]),
    );
    await vi.waitFor(() => expect(attempt).toBeGreaterThan(1));
    fixture.watch.dispose();
  });

  /**
   * The defect a stubbed predicate could not show: `handoffPending()` reads this
   * window's in-memory copy, and the only thing that refreshes that copy from
   * disk — `RemoteHandoffCoordinator.poll` — runs inside the lifecycle chain
   * this window's own lease retry is holding. So while a retry is in flight the
   * watch has to read the shared file itself, through the store's write tail.
   * Here both stores and the record are real, so a watch that trusted its own
   * copy would sit on a completed record until the TTL.
   *
   * `retryClaim` resolves when its signal aborts, standing in for
   * `claimWorkspaceArrivals`'s `takeOver` loop against a held lease — the abort
   * reaching that loop is what `RemoteTakeoverRetry.test.ts` already proves.
   */
  it('cancels a retry from disk, not from the copy the retry itself keeps stale', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-window-watch-'));
    const statePath = path.join(directory, 'remote-state-v2.json');
    const windowThatWasAsked = new RemoteRequestStore(statePath);
    await windowThatWasAsked.load();
    const id = await windowThatWasAsked.beginWorkspaceHandoff({
      channel: 'telegram',
      chatId: 'chat-a',
      sourceWorkspaceId: 'source-workspace',
      targetWorkspaceId: 'target-workspace',
      targetAlias: 'here',
      mode: 'new-window',
    });
    const signals: AbortSignal[] = [];
    const refreshes = { count: 0 };
    const fixture = watchFixture({
      handoffPending: () => windowThatWasAsked.hasPendingWorkspaceHandoff('target-workspace'),
      // The wiring `RemoteRuntime` uses, counted: the assertion below is that
      // this read happened **while** the attempt was still running.
      refreshHandoff: async () => {
        refreshes.count += 1;
        await windowThatWasAsked.refresh();
      },
      retryClaim: (signal) =>
        new Promise<void>((resolve) => {
          signals.push(signal);
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    try {
      fixture.watch.start();
      await vi.waitFor(() => expect(signals.length).toBe(1));
      // The copy this window is being asked to trust: it says a chat is waiting
      // here, and it will keep saying so until somebody reads the file.
      expect(windowThatWasAsked.hasPendingWorkspaceHandoff('target-workspace')).toBe(true);
      // A second store instance is all another VS Code window is here. It
      // completes the record on disk and touches nothing in this window.
      const windowThatTookTheChat = new RemoteRequestStore(statePath);
      await windowThatTookTheChat.load();
      await windowThatTookTheChat.claimAndBindWorkspaceHandoff(id, 'target-workspace');
      // Well before 90 s, and quietly: nothing went wrong with this window, the
      // chat simply landed somewhere else, so a cancelled retry says nothing.
      await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true), { timeout: 2_000 });
      // The disk read is what did it. `refreshes` proves the read happened
      // while the attempt was still in flight, and the copy above is what it
      // replaced — which is the state that made the old test pass for the wrong
      // reason, when the predicate was a stub this window could not go stale on.
      expect(refreshes.count).toBeGreaterThan(0);
      expect(windowThatWasAsked.hasPendingWorkspaceHandoff('target-workspace')).toBe(false);
      expect(fixture.notified).toEqual([]);
    } finally {
      fixture.watch.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  /**
   * The same record with the file read taken away, which is the defect this
   * fix removed: the in-memory copy still says a chat is waiting, so the cancel
   * never fires, the attempt runs to its own deadline, and the window reports a
   * failure for a chat another window is answering on the phone right now.
   */
  it('does not cancel a retry when nothing reads the file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-window-watch-'));
    const statePath = path.join(directory, 'remote-state-v2.json');
    const windowThatWasAsked = new RemoteRequestStore(statePath);
    await windowThatWasAsked.load();
    const id = await windowThatWasAsked.beginWorkspaceHandoff({
      channel: 'telegram',
      chatId: 'chat-a',
      sourceWorkspaceId: 'source-workspace',
      targetWorkspaceId: 'target-workspace',
      targetAlias: 'here',
      mode: 'new-window',
    });
    const signals: AbortSignal[] = [];
    const fixture = watchFixture({
      handoffPending: () => windowThatWasAsked.hasPendingWorkspaceHandoff('target-workspace'),
      // A refresh that does not touch the file — exactly what the in-memory
      // copy gives a watch whose only other refresh is stuck behind the
      // attempt it is meant to cancel.
      refreshHandoff: async () => undefined,
      retryClaim: (signal) =>
        new Promise<void>((resolve, reject) => {
          signals.push(signal);
          // Stands in for `claimWorkspaceArrivals`'s `takeOver` loop: it ends
          // either because the signal was aborted or because its own deadline
          // passed, and only the first counts as a cancel.
          setTimeout(() => {
            if (signal.aborted) resolve();
            else reject(new Error('lease still held by another window'));
          }, 120);
        }),
    });
    try {
      fixture.watch.start();
      await vi.waitFor(() => expect(signals.length).toBe(1));
      const windowThatTookTheChat = new RemoteRequestStore(statePath);
      await windowThatTookTheChat.load();
      await windowThatTookTheChat.claimAndBindWorkspaceHandoff(id, 'target-workspace');
      // Nothing was cancelled, so the attempt reports its own failure — the
      // message that used to reach the log for a chat that is being served.
      await vi.waitFor(() => expect(fixture.notified.length).toBeGreaterThan(0));
      expect(signals[0]?.aborted).toBe(false);
      expect(fixture.notified[0]).toContain('could not claim an arriving chat');
      expect(windowThatWasAsked.hasPendingWorkspaceHandoff('target-workspace')).toBe(true);
    } finally {
      fixture.watch.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  /**
   * Phase 3's first criterion: a window that is not serving and has nothing
   * handed to it is still a window that could serve, and this watch is the only
   * thing that still tries. The window that used to answer the phone closed,
   * its lease went stale at the 20 s horizon, and without this branch the chat
   * is silent until somebody reloads — which is what `RemoteStartRetry` has
   * always assumed, because it treats a lease refusal as "not mine to serve".
   */
  it('tries to come back into service when nothing was handed here', async () => {
    const fixture = watchFixture();
    fixture.pending.value = false;
    fixture.watch.start();
    await vi.waitFor(() => expect(fixture.comeBacks.length).toBeGreaterThan(0), {
      timeout: 5_000,
    });
    expect(fixture.comeBacks[0]).toBeInstanceOf(AbortSignal);
    // A claim retry is not the same thing and must not run: there is no record
    // here, so a 90 s claim wait would be a wait for a chat that is not coming.
    expect(fixture.claims).toHaveLength(0);
    expect(fixture.notified).toEqual([]);
    fixture.watch.dispose();
  });

  /** This repo's first question, asked of the new wait: what cancels it, and is
   *  that path tested? A come-back has no record, so the record check must not
   *  cancel it — otherwise a window merely waiting for a lease has its attempt
   *  thrown away every tick and never takes one. `dispose()` is what cancels
   *  it, and its own 2 s deadline bounds it; one may be in flight at a time.
   */
  it('runs one come-back at a time, keeps it out of the record check, and cancels it on dispose', async () => {
    const signals: AbortSignal[] = [];
    const fixture = watchFixture({
      comeBack: (signal) =>
        new Promise<void>((resolve) => {
          signals.push(signal);
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    fixture.pending.value = false;
    fixture.watch.start();
    await vi.waitFor(() => expect(signals.length).toBe(1), { timeout: 5_000 });
    expect(signals[0]?.aborted).toBe(false);
    // Many ticks pass with the attempt in flight: exactly one may be running,
    // and none of them reads the state file for a record that does not exist.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(signals).toHaveLength(1);
    expect(fixture.refreshes.count).toBe(0);
    expect(signals[0]?.aborted).toBe(false);
    expect(fixture.notified).toEqual([]);
    fixture.watch.dispose();
    expect(signals[0]?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(signals).toHaveLength(1);
  });

  /** A come-back that fails for a real reason is still worth saying once: the
   *  next tick will try again, and a window that cannot start its transports
   *  for a reason that is not a lease must not be invisible. A lease refusal
   *  never reaches this message — `comeBackIntoService` swallows it. */
  it('reports a failed come-back once and keeps trying', async () => {
    let attempt = 0;
    const fixture = watchFixture({
      comeBack: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('the transport factory is unavailable');
      },
    });
    fixture.pending.value = false;
    fixture.watch.start();
    await vi.waitFor(() =>
      expect(fixture.notified).toEqual([
        'Forge remote could not come back into service: the transport factory is unavailable',
      ]),
      { timeout: 5_000 },
    );
    await vi.waitFor(() => expect(attempt).toBeGreaterThan(1), { timeout: 5_000 });
    fixture.watch.dispose();
  });

  /**
   * The come-back's one gate, and the defect it prevents: this window ran a
   * `new-window` switch, so it stopped its transports and released the lease on
   * purpose, and it is waiting for the window it asked to be opened to claim the
   * chat. Taking the free lease one tick after that switch would leave a cold
   * target — 73 s open→activation, measured in phase 0 — unable to get the
   * phone at all, and the switch would fail and be undone for a move that would
   * have worked. The armed rollback, not this watch, owns that window's
   * silence, and it clears itself: it fires, or the target claims and this
   * window's next attempt is refused by a live lease.
   */
  it('waits for the window it asked to be opened instead of taking the phone back', async () => {
    const fixture = watchFixture();
    fixture.pending.value = false;
    fixture.waitingForTargetWindow.value = true;
    fixture.watch.start();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    // No lease work at all: not a come-back, not a claim, and not even a disk
    // read for a record that is not coming here.
    expect(fixture.comeBacks).toHaveLength(0);
    expect(fixture.claims).toHaveLength(0);
    expect(fixture.refreshes.count).toBe(0);
    expect(fixture.notified).toEqual([]);
    // A chat handed **here** still outranks the wait: that record is this
    // window's own claim, while the switch it asked for is addressed to another
    // window, so a pending record must never be traded away for the come-back.
    fixture.pending.value = true;
    await vi.waitFor(() => expect(fixture.claims.length).toBeGreaterThan(0), {
      timeout: 5_000,
    });
    // The wait is over — the rollback fired, or the target took the chat — and
    // this window is back in the contest for the phone.
    fixture.pending.value = false;
    fixture.waitingForTargetWindow.value = false;
    await vi.waitFor(() => expect(fixture.comeBacks.length).toBeGreaterThan(0), {
      timeout: 5_000,
    });
    fixture.watch.dispose();
  });

  /** A come-back that keeps failing must not turn into an error toast every five
   *  seconds for as long as the window is open: `notifyLocal` is
   *  `showErrorMessage`, and a transport that cannot start — a missing token,
   *  say — fails identically on every tick, forever. Say it once; a different
   *  failure is still new information and is still said.
   */
  it('says the same failure once, not once per tick', async () => {
    let attempts = 0;
    const fixture = watchFixture({
      comeBack: async () => {
        attempts += 1;
        throw new Error('the transport factory is unavailable');
      },
      retryClaim: async () => {
        throw new Error('the transport factory is unavailable');
      },
    });
    fixture.pending.value = false;
    fixture.watch.start();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    // Repeated, and reported once: the retrying is the point, the toast is not.
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(1), { timeout: 5_000 });
    expect(fixture.notified).toEqual([
      'Forge remote could not come back into service: the transport factory is unavailable',
    ]);
    // A different failure — here, the same window's claim path — is still worth
    // hearing, so it is said too rather than swallowed by the de-duplication.
    fixture.pending.value = true;
    await vi.waitFor(
      () =>
        expect(fixture.notified).toEqual([
          'Forge remote could not come back into service: the transport factory is unavailable',
          'Forge remote could not claim an arriving chat: the transport factory is unavailable',
        ]),
      { timeout: 5_000 },
    );
    fixture.watch.dispose();
  });
});

/**
 * Phase 3's other half of the same timer: the window's own close inbox, and the
 * outcomes it has to carry for windows that could not message the phone. The
 * question this section answers is the one the plan asks of every new wait —
 * `dispose()` has to clear the close read as well as the claim retry, and a
 * window that is not serving must not try to send anything.
 */
describe('RemoteWindowWatch close inbox', { timeout: 30_000 }, () => {
  it('reads its own close-request every tick, serving or not', async () => {
    const reads: AbortSignal[] = [];
    const fixture = watchFixture({
      readCloseRequest: async (signal) => {
        reads.push(signal);
      },
    });
    // This window is answering the phone, which is exactly when a phone Close
    // arrives at the wrong window: it still has to read its own inbox to refuse
    // it, or the phone would sit waiting for a minute for nothing.
    fixture.serving.value = true;
    fixture.watch.start();
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(1), { timeout: 5_000 });
    expect(reads[0]).toBeInstanceOf(AbortSignal);
    fixture.watch.dispose();
  });

  it('reports close outcomes only while this window holds the lease', async () => {
    const reports: AbortSignal[] = [];
    const fixture = watchFixture({
      reportCloseResults: async (signal) => {
        reports.push(signal);
      },
    });
    fixture.watch.start();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    // Not serving: reading and sending the phone's messages is the serving
    // window's job, which is why an outcome is a file instead of a send.
    expect(reports).toHaveLength(0);
    fixture.serving.value = true;
    await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0), { timeout: 5_000 });
    fixture.watch.dispose();
  });

  it('cancels a close read in flight and never reads again after dispose', async () => {
    const reads: AbortSignal[] = [];
    const fixture = watchFixture({
      // A read that only ends when its signal aborts: a window the phone asked
      // to close, deciding, while the window itself goes away.
      readCloseRequest: (signal) =>
        new Promise<void>((resolve) => {
          reads.push(signal);
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    fixture.watch.start();
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(0), { timeout: 5_000 });
    expect(reads[0]!.aborted).toBe(false);
    fixture.watch.dispose();
    expect(reads[0]!.aborted).toBe(true);
    const whileShuttingDown = reads.length;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    // No new reads, because the interval is gone: a close cannot happen after
    // `dispose()` on a window that is already closing.
    expect(reads).toHaveLength(whileShuttingDown);
  });

  it('does not starve a close request behind a claim retry in flight', async () => {
    const claims: AbortSignal[] = [];
    const closeReads: AbortSignal[] = [];
    let releaseClaim: () => void = () => undefined;
    const claim = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const fixture = watchFixture({
      retryClaim: async (signal) => {
        claims.push(signal);
        await claim;
      },
      readCloseRequest: async () => {
        closeReads.push(new AbortController().signal);
      },
    });
    fixture.pending.value = true;
    fixture.watch.start();
    await vi.waitFor(() => expect(claims.length).toBe(1), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    // One attempt is still in flight, and only one: the watch is single-flight on
    // its own account, because `takeOver` runs past the 20 s stale horizon.
    expect(claims.length).toBe(1);
    // The inbox kept being read on the later ticks anyway: a window the phone
    // asked to close must not wait out another window's lease contest to answer.
    expect(closeReads.length).toBeGreaterThan(1);
    releaseClaim();
    fixture.pending.value = false;
    fixture.watch.dispose();
  });

  it('says an inbox failure once, the way it says every other repeating failure', async () => {
    let attempts = 0;
    const fixture = watchFixture({
      readCloseRequest: async () => {
        attempts += 1;
        throw new Error('the window folder is unreadable');
      },
    });
    fixture.pending.value = false;
    fixture.serving.value = true;
    fixture.watch.start();
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(1), { timeout: 5_000 });
    expect(fixture.notified).toEqual([
      'Forge remote could not act on a window request: the window folder is unreadable',
    ]);
    fixture.watch.dispose();
  });
});
