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
  const watch = new RemoteWindowWatch({
    tickIntervalMs: TICK_MS,
    handoffPending: () => pending.value,
    refreshHandoff: async () => {
      refreshes.count += 1;
    },
    serving: () => serving.value,
    isDisposed: () => disposed.value,
    notifyLocal: (message) => notified.push(message),
    ...overrides,
  });
  return { watch, pending, serving, disposed, notified, refreshes };
}

describe('RemoteWindowWatch', () => {
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

  it('does nothing when nothing is waiting, or when this window already serves', async () => {
    const calls: AbortSignal[] = [];
    const fixture = watchFixture({
      retryClaim: async (signal) => {
        calls.push(signal);
      },
    });
    fixture.pending.value = false;
    fixture.watch.start();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(calls).toHaveLength(0);

    fixture.pending.value = true;
    fixture.serving.value = true;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(calls).toHaveLength(0);
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
});
