/**
 * The window files and the count a `new-window` switch is capped against.
 *
 * Phase 3 of `docs/plans/TELEGRAM_WORKSPACE_SWITCH_SAFETY_PLAN.md`. The criteria
 * this file carries are the ones the plan says only a lifecycle test can prove —
 * `remote-windows/` empty after activation, close and death — plus the two
 * questions this repo asks of every change: what cancels the wait, and what
 * proves a request came from the right window.
 *
 * Liveness and the clock are injected everywhere, so a "dead" window is a pid
 * this file says is dead and never a race against a fast machine.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostId } from '../../src/agentMesh/hostIdentity';
import { workspaceIdFor } from '../../src/remote/RemoteWorkspaceHandoff';
import {
  CLOSE_TTL_MS,
  STILL_ALIVE_REWRITE_MS,
  readCloseRequest,
  reportCloseResults,
  runWindowClose,
} from '../../src/remote/RemoteWindowClose';
import {
  countOpenWindows,
  createRemoteWindowSurface,
  publishWindowRecord,
  readWindowRecords,
  refuseOverCap,
  removeWindowRecord,
  windowDirectory,
  windowIdFor,
  writeCloseRequest,
  type RemoteWindowRecord,
} from '../../src/remote/RemoteWindowRegistry';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function windowsDirectory(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return windowDirectory(root);
}

const ALIVE: HostId = { pid: 4_242_424, startedAt: 1_700_000_000_000 };
const DEAD: HostId = { pid: 4_141_414, startedAt: 1_700_000_000_000 };
const ALIVE_ID = windowIdFor(ALIVE);
const DEAD_ID = windowIdFor(DEAD);

/** Liveness by pid only, which is how `isHostAlive` reads a dead host. */
function aliveByPid(alive: readonly number[]): (recorded: HostId) => boolean {
  return (recorded) => alive.includes(recorded.pid);
}

function recordFor(
  host: HostId,
  workspaceId: string,
  workspaceName: string,
  overrides: Partial<RemoteWindowRecord> = {},
): RemoteWindowRecord {
  return {
    windowId: windowIdFor(host),
    host,
    workspaceId,
    workspaceName,
    workspacePath: `N:\\${workspaceName}`,
    serving: false,
    writtenAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** A surface with no OS probe, so the count comes from the files it was built on. */
function surfaceFor(
  directory: string,
  options: {
    ownWindowId?: string;
    cap?: number;
    aliases?: Record<string, { path: string; display_name: string }>;
    alive?: readonly number[];
    osWindows?: number;
  } = {},
) {
  // Hoisted so the two probe shapes below narrow on a constant rather than on a
  // captured optional property, which the type checker cannot do on its own.
  const osWindows = options.osWindows;
  return createRemoteWindowSurface({
    directory,
    ownWindowId: () => options.ownWindowId ?? ALIVE_ID,
    probe:
      osWindows === undefined
        ? { count: async () => ({ source: 'unavailable', reason: 'not windows' }) }
        : {
            count: async () => ({
              source: 'os',
              windows: Array.from({ length: osWindows }, (_ignored, index) => ({
                // The same pid for every window, because that is what the real
                // probe returns: one VS Code instance, one main process.
                pid: 27_124,
                image: 'Code',
                className: 'Chrome_WidgetWin_1',
                title: `window ${index + 1}`,
              })),
            }),
          },
    cap: () => options.cap ?? 5,
    setCap: async () => undefined,
    aliasesFor: () => options.aliases ?? {},
    isHostAlive: aliveByPid(options.alive ?? [ALIVE.pid]),
  });
}

/** The target window's side of a Close, with every fact it needs injected. */
function closeRunner(
  directory: string,
  options: {
    windowId?: string;
    windowName?: string;
    holdsLease?: () => boolean;
    hasUnsavedEditors?: () => boolean;
    busyReason?: () => string | undefined;
    closeWindow?: () => Promise<void>;
    now?: () => number;
    isHostAlive?: (recorded: HostId) => boolean;
    signal?: AbortSignal;
  } = {},
) {
  const closed: string[] = [];
  return {
    closed,
    run: () =>
      runWindowClose({
        directory,
        windowName: options.windowName ?? 'Strata',
        signal: options.signal ?? new AbortController().signal,
        holdsLease: options.holdsLease ?? (() => false),
        closeWindow:
          options.closeWindow ??
          (async () => {
            closed.push('closed');
          }),
        ...(options.windowId ? { windowId: options.windowId } : {}),
        ...(options.hasUnsavedEditors ? { hasUnsavedEditors: options.hasUnsavedEditors } : {}),
        ...(options.busyReason ? { busyReason: options.busyReason } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.isHostAlive ? { isHostAlive: options.isHostAlive } : {}),
      }),
  };
}

/**
 * Everything the phone was told, as one string, so refusals can be asserted.
 *
 * Liveness is injected here too: a `closed` report is held or sent by this file's
 * answer about which pids are live, never by whichever processes happen to be
 * running on the CI machine. With no record file in the folder the target is
 * proven gone either way — that is the `deactivate()` path — so the tests that
 * never published a record keep meaning exactly what they meant.
 */
async function drainResults(
  directory: string,
  options: { now?: () => number; failSend?: boolean; alive?: readonly number[] } = {},
): Promise<{
  sent: string[];
  reported: number;
  expired: number;
  unreadable: number;
  waiting: number;
}> {
  const sent: string[] = [];
  const outcome = await reportCloseResults({
    directory,
    ...(options.now ? { now: options.now } : {}),
    isHostAlive: aliveByPid(options.alive ?? [ALIVE.pid]),
    send: options.failSend
      ? async () => {
          throw new Error('no transport to report on');
        }
      : async (_channel, _chatId, text) => {
          sent.push(text);
        },
  });
  return { ...outcome, sent };
}

describe('the window records', () => {
  it('writes one file per window and prunes a record whose host is dead', async () => {
    const directory = await windowsDirectory('forge-window-records-');
    await publishWindowRecord({ directory, record: recordFor(ALIVE, 'ws-forge', 'Forge') });
    await publishWindowRecord({ directory, record: recordFor(DEAD, 'ws-strata', 'Strata') });
    const read = await readWindowRecords({ directory, isHostAlive: aliveByPid([ALIVE.pid]) });
    expect(read.pruned).toBe(1);
    expect(read.records.map((record) => record.workspaceName)).toEqual(['Forge']);
    expect(read.unreadable).toBe(0);
    // The pruned record's file is gone, and this is the only prune path there is:
    // no clock walks this folder.
    expect(await fs.readdir(directory)).toEqual([`${ALIVE_ID}.json`]);
  });

  it("keeps a live host's record however stale it is: age alone never prunes", async () => {
    const directory = await windowsDirectory('forge-window-stale-');
    // Written a day ago and never refreshed — there is no heartbeat to refresh it
    // with, which is the whole reason age cannot be the test.
    await publishWindowRecord({
      directory,
      record: recordFor(ALIVE, 'ws-forge', 'Forge', {
        writtenAt: Date.now() - 24 * 60 * 60 * 1000,
        serving: true,
      }),
    });
    const read = await readWindowRecords({ directory, isHostAlive: aliveByPid([ALIVE.pid]) });
    expect(read.pruned).toBe(0);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]!.serving).toBe(true);
  });

  it('counts a record it cannot read as a window, and prunes it only when its pid is gone', async () => {
    const directory = await windowsDirectory('forge-window-torn-');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${ALIVE_ID}.json`), '{"windowId":"x",not json', 'utf8');
    const live = await readWindowRecords({
      directory,
      isHostAlive: aliveByPid([ALIVE.pid]),
      isPidAlive: (pid) => pid === ALIVE.pid,
    });
    expect(live.records).toHaveLength(0);
    expect(live.unreadable).toBe(1);
    // A foreign shape is not evidence of death; a gone pid is.
    await fs.writeFile(path.join(directory, `${DEAD_ID}.json`), 'not json', 'utf8');
    const after = await readWindowRecords({
      directory,
      isHostAlive: aliveByPid([ALIVE.pid]),
      isPidAlive: (pid) => pid === ALIVE.pid,
    });
    expect(after.unreadable).toBe(1);
    expect(after.pruned).toBe(1);
  });

  it('leaves remote-windows empty after a full lifecycle: activation, close, death', async () => {
    const directory = await windowsDirectory('forge-window-lifecycle-');
    // The CI-enforced row: every kind of file this feature can write, opened and
    // closed, must leave the folder empty, so a future record type with no prune
    // path fails here instead of quietly accumulating.
    await publishWindowRecord({ directory, record: recordFor(ALIVE, 'ws-forge', 'Forge') });
    await publishWindowRecord({ directory, record: recordFor(DEAD, 'ws-strata', 'Strata') });
    for (const windowId of [ALIVE_ID, DEAD_ID]) {
      await writeCloseRequest({
        directory,
        windowId,
        channel: 'telegram',
        chatId: 'chat',
        requester: ALIVE,
      });
    }
    // The serving window refuses its own close; the other one closes itself.
    const refused = await closeRunner(directory, {
      windowId: ALIVE_ID,
      windowName: 'Forge',
      holdsLease: () => true,
    }).run();
    expect(refused.outcome).toBe('refused');
    const closed = await closeRunner(directory, { windowId: DEAD_ID }).run();
    expect(closed.outcome).toBe('closed');
    // The window that closed cannot report for itself, so the serving window
    // carries both outcomes and clears them.
    const drained = await drainResults(directory);
    expect(drained.reported).toBe(2);
    const texts = drained.sent.join('\n');
    expect(texts).toContain('Forge closed Strata.');
    expect(texts).toContain('Forge did not close Forge: it is answering your phone');
    // The owner then closes their own window from the palette: `deactivate()`
    // gives up its record, and the window that closed itself leaves its record
    // for the next reader to prune once its host is proven dead.
    await removeWindowRecord({ directory, windowId: ALIVE_ID });
    await readWindowRecords({
      directory,
      isHostAlive: () => false,
      isPidAlive: () => false,
    });
    expect(await fs.readdir(directory)).toEqual([]);
  });
});

describe('closing a window from its own close-request', () => {
  it('consumes a request exactly once', async () => {
    const directory = await windowsDirectory('forge-close-once-');
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    const runner = closeRunner(directory, { windowId: ALIVE_ID });
    expect((await runner.run()).outcome).toBe('closed');
    expect(runner.closed).toEqual(['closed']);
    // The same file cannot close the window twice: the next tick sees nothing.
    expect((await runner.run()).outcome).toBe('none');
    expect(runner.closed).toEqual(['closed']);
  });

  it('never closes a window on a request older than 60 s, and reports the missed close', async () => {
    const directory = await windowsDirectory('forge-close-expiry-');
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    // The window was busy for a minute and a half, so the request sat unread.
    const runner = closeRunner(directory, {
      windowId: ALIVE_ID,
      now: () => Date.now() + CLOSE_TTL_MS + 30_000,
    });
    const outcome = await runner.run();
    expect(outcome.outcome).toBe('refused');
    expect(outcome.reason).toContain('nobody acted on it');
    expect(runner.closed).toEqual([]);
    // Consumed, not left for a later tick to act on late.
    expect((await readCloseRequest({ directory, windowId: ALIVE_ID })).kind).toBe('none');
    const drained = await drainResults(directory);
    expect(drained.sent[0]).toContain('nobody acted on it');
  });

  it('refuses the window that holds the lease, before any other check', async () => {
    const directory = await windowsDirectory('forge-close-lease-');
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    const runner = closeRunner(directory, {
      windowId: ALIVE_ID,
      holdsLease: () => true,
      // Idle and clean: the lease alone is enough, because nothing takes the
      // phone back after the serving window closes.
      hasUnsavedEditors: () => false,
      busyReason: () => undefined,
    });
    const outcome = await runner.run();
    expect(outcome.outcome).toBe('refused');
    expect(outcome.reason).toContain('answering your phone');
    expect(runner.closed).toEqual([]);
  });

  it('refuses a window with unsaved editors instead of opening a save prompt', async () => {
    const directory = await windowsDirectory('forge-close-dirty-');
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    const runner = closeRunner(directory, {
      windowId: ALIVE_ID,
      hasUnsavedEditors: () => true,
    });
    const outcome = await runner.run();
    expect(outcome.outcome).toBe('refused');
    expect(outcome.reason).toContain('unsaved editors');
    expect(runner.closed).toEqual([]);
  });

  /**
   * The four busy sources the plan names — a running turn, a job, a delegated
   * CLI agent and a pending approval — all arrive through the one gate the
   * owner's own destructive commands already use, so each is tested as that gate
   * would report it.
   */
  it.each([
    ['a running turn', 'Forge is busy; wait for requests, streams, and approvals to finish'],
    ['a job between rounds', 'Forge has queued remote requests'],
    ['a delegated CLI agent', 'Forge is busy; a delegated agent is answering'],
    ['a pending approval', 'Forge is busy; a tool approval is waiting'],
  ])('refuses while %s is running', async (_label, reason) => {
    const directory = await windowsDirectory('forge-close-busy-');
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    const runner = closeRunner(directory, {
      windowId: ALIVE_ID,
      busyReason: () => reason,
    });
    const outcome = await runner.run();
    expect(outcome.outcome).toBe('refused');
    expect(outcome.reason).toBe(reason);
    expect(runner.closed).toEqual([]);
    // The refusal is reported, not swallowed: the phone asked and has to be told.
    const drained = await drainResults(directory);
    expect(drained.sent).toHaveLength(1);
    expect(drained.sent[0]).toContain(reason);
  });

  it('closes nothing for a close-request it cannot read', async () => {
    const directory = await windowsDirectory('forge-close-torn-');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${ALIVE_ID}.close-request.json`), '{"windowId":', 'utf8');
    const runner = closeRunner(directory, { windowId: ALIVE_ID });
    expect((await runner.run()).outcome).toBe('unknown');
    expect(runner.closed).toEqual([]);
    // A torn request names no chat, so there is no result to report either.
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('prunes a close-request only when the window that asked is proven dead', async () => {
    const directory = await windowsDirectory('forge-close-requester-');
    const target = DEAD_ID;
    await writeCloseRequest({
      directory,
      windowId: target,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    // Both windows alive: the request stands and the window closes.
    const alive = await closeRunner(directory, {
      windowId: target,
      isHostAlive: aliveByPid([DEAD.pid, ALIVE.pid]),
    }).run();
    expect(alive.outcome).toBe('closed');
    await writeCloseRequest({
      directory,
      windowId: target,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    // Same request, requester now dead: refused and consumed, because nobody is
    // left to tell.
    const dead = await closeRunner(directory, {
      windowId: target,
      isHostAlive: aliveByPid([DEAD.pid]),
    }).run();
    expect(dead.outcome).toBe('refused');
    expect(dead.reason).toContain('the window that asked');
    expect((await readCloseRequest({ directory, windowId: target })).kind).toBe('none');
  });

  it('writes success before closing so a failed close overwrites it', async () => {
    const directory = await windowsDirectory('forge-close-failed-');
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    const outcome = await closeRunner(directory, {
      windowId: ALIVE_ID,
      closeWindow: async () => {
        throw new Error('workbench refused');
      },
    }).run();
    expect(outcome.outcome).toBe('refused');
    const drained = await drainResults(directory);
    expect(drained.sent[0]).toContain('workbench refused');
    expect(drained.sent[0]).not.toContain('Forge closed');
  });

  it('rewrites a closed claim as unknown when the window is still here', async () => {
    const directory = await windowsDirectory('forge-close-still-open-');
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    // `workbench.action.closeWindow` resolves and the window survives: a veto,
    // or an extension host that is merely slow to go.
    await closeRunner(directory, { windowId: ALIVE_ID }).run();
    // Too early to tell — a close under way looks the same as a veto.
    const early = await closeRunner(directory, { windowId: ALIVE_ID }).run();
    expect(early.outcome).toBe('none');
    const later = await closeRunner(directory, {
      windowId: ALIVE_ID,
      now: () => Date.now() + STILL_ALIVE_REWRITE_MS + 1,
    }).run();
    expect(later.outcome).toBe('none');
    const drained = await drainResults(directory);
    expect(drained.sent[0]).toContain('could not confirm whether Strata closed');
    expect(drained.sent[0]).toContain('it is still open');
    expect(drained.sent[0]).not.toContain('Forge closed');
  });

  it('reports a result once, keeps it when the send fails, and drops one nobody served for', async () => {
    const directory = await windowsDirectory('forge-close-results-');
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    await closeRunner(directory, { windowId: ALIVE_ID }).run();
    const failing = await drainResults(directory, { failSend: true });
    expect(failing.reported).toBe(0);
    // Still there: the next tick tries again, and the file's own 60 s is what
    // finally stops it.
    const ok = await drainResults(directory);
    expect(ok.reported).toBe(1);
    expect(ok.sent[0]).toContain('Forge closed Strata.');
    expect(await fs.readdir(directory)).toEqual([]);
    // The same, with nobody serving while it waited: expired, unread.
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    await closeRunner(directory, { windowId: ALIVE_ID }).run();
    const late = await drainResults(directory, {
      now: () => Date.now() + CLOSE_TTL_MS + 1,
      failSend: true,
    });
    expect(late.expired).toBe(1);
    expect(late.reported).toBe(0);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  /**
   * The defect these three tests answer for: `workbench.action.closeWindow` can
   * be vetoed (hot exit, a notebook or custom editor's save prompt, an extension
   * that refuses), and the window that wrote “closed” is the one window that
   * cannot say so. The reporter therefore sends a `closed` claim only once the
   * target is proven gone, the same proof every other reader of this folder uses.
   */
  it('holds a “closed” result while the window it names is still alive', async () => {
    const directory = await windowsDirectory('forge-close-held-');
    // The target published its record at activation and is still here: a close
    // under way and a close that was vetoed look exactly like a finished one.
    await publishWindowRecord({ directory, record: recordFor(ALIVE, 'ws-strata', 'Strata') });
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    expect((await closeRunner(directory, { windowId: ALIVE_ID }).run()).outcome).toBe('closed');
    const held = await drainResults(directory, { alive: [ALIVE.pid] });
    expect(held.reported).toBe(0);
    expect(held.waiting).toBe(1);
    expect(held.sent).toEqual([]);
    // Held, not consumed: the next tick asks again, and a live window's record is
    // nobody's to prune, so both files are still there. Sorted because the folder
    // order is the filesystem's, not the assertion's.
    const again = await drainResults(directory, { alive: [ALIVE.pid] });
    expect(again.waiting).toBe(1);
    expect(again.sent).toEqual([]);
    expect((await fs.readdir(directory)).sort()).toEqual([
      `${ALIVE_ID}.close-result.json`,
      `${ALIVE_ID}.json`,
    ]);
    // And it dies there rather than living forever: the 60 s TTL is checked before
    // the proof, so an unproved claim expires instead of being held by a window
    // that will never go. In practice the phone has already been told — the
    // target's 15 s rewrite needs no proof to be reported — so what is lost here
    // is a duplicate, never the answer.
    const late = await drainResults(directory, {
      alive: [ALIVE.pid],
      now: () => Date.now() + CLOSE_TTL_MS + 1,
    });
    expect(late.expired).toBe(1);
    expect(late.reported).toBe(0);
    expect(late.sent).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([`${ALIVE_ID}.json`]);
  });

  it('reports “closed” once the target is proven gone, by death or by its own deactivate', async () => {
    const directory = await windowsDirectory('forge-close-gone-');
    await publishWindowRecord({ directory, record: recordFor(ALIVE, 'ws-strata', 'Strata') });
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    expect((await closeRunner(directory, { windowId: ALIVE_ID }).run()).outcome).toBe('closed');
    // Crash or kill: the record is still on disk and its host is proven dead, so
    // the reporter prunes it as any reader may and the report goes out at once.
    const dead = await drainResults(directory, { alive: [] });
    expect(dead.reported).toBe(1);
    expect(dead.waiting).toBe(0);
    expect(dead.sent[0]).toContain('Forge closed Strata.');
    expect(await fs.readdir(directory)).toEqual([]);
    // The clean path: the window gave its own record up at `deactivate()`, so an
    // alive pid is no reason to hold a report about a window that said goodbye.
    await publishWindowRecord({ directory, record: recordFor(ALIVE, 'ws-strata', 'Strata') });
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    expect((await closeRunner(directory, { windowId: ALIVE_ID }).run()).outcome).toBe('closed');
    await removeWindowRecord({ directory, windowId: ALIVE_ID });
    const clean = await drainResults(directory, { alive: [ALIVE.pid] });
    expect(clean.reported).toBe(1);
    expect(clean.waiting).toBe(0);
    expect(clean.sent[0]).toContain('Forge closed Strata.');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('a vetoed close: the phone hears exactly one message, the unknown one, never a success', async () => {
    const directory = await windowsDirectory('forge-close-veto-');
    await publishWindowRecord({ directory, record: recordFor(ALIVE, 'ws-strata', 'Strata') });
    await writeCloseRequest({
      directory,
      windowId: ALIVE_ID,
      channel: 'telegram',
      chatId: 'chat',
      requester: ALIVE,
    });
    // `workbench.action.closeWindow` resolves and the window survives.
    expect((await closeRunner(directory, { windowId: ALIVE_ID }).run()).outcome).toBe('closed');
    // The serving window's next tick, five seconds on: nothing to say yet, because
    // a close that has not happened cannot be reported as one.
    const first = await drainResults(directory, { alive: [ALIVE.pid] });
    expect(first.sent).toEqual([]);
    expect(first.waiting).toBe(1);
    // 15 s on, the target's own tick stops believing its claim and rewrites it —
    // inside the 60 s the claim would otherwise expire at, so the phone is never
    // told a success and then its reversal.
    await closeRunner(directory, {
      windowId: ALIVE_ID,
      now: () => Date.now() + STILL_ALIVE_REWRITE_MS + 1,
    }).run();
    const second = await drainResults(directory, { alive: [ALIVE.pid] });
    const heard = [...first.sent, ...second.sent];
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain('could not confirm whether Strata closed');
    expect(heard[0]).toContain('it is still open');
    expect(heard.join(' ')).not.toContain('Forge closed');
  });

  it('drops a result it cannot read without counting it as a reported success', async () => {
    const directory = await windowsDirectory('forge-close-result-torn-');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, `${ALIVE_ID}.close-result.json`),
      '{"outcome":"closed"',
      'utf8',
    );
    const drained = await drainResults(directory);
    expect(drained.unreadable).toBe(1);
    expect(drained.reported).toBe(0);
    expect(drained.sent).toEqual([]);
    // Consumed either way, or every tick would re-read the same broken record.
    expect(await fs.readdir(directory)).toEqual([]);
  });
});

describe('the open-window count and the cap', () => {
  it('counts the OS windows and not the files, with no join by pid', async () => {
    const directory = await windowsDirectory('forge-window-count-');
    await publishWindowRecord({ directory, record: recordFor(ALIVE, 'ws-forge', 'Forge') });
    const read = await readWindowRecords({ directory, isHostAlive: aliveByPid([ALIVE.pid]) });
    // Real-shaped records — pid, image name, class, title — and the same pid for
    // every one of them, because that is what the real probe returns: every
    // window of one VS Code instance belongs to the same main process, so there
    // is no key to join the files and the OS list on. `Code - Insiders` is in the
    // set or an Insiders install is counted wrong.
    const windows = [
      { pid: 27_124, image: 'Code', className: 'Chrome_WidgetWin_1', title: 'Forge - VS Code' },
      {
        pid: 27_124,
        image: 'Code - Insiders',
        className: 'Chrome_WidgetWin_1',
        title: 'Strata - VS Code Insiders',
      },
      {
        pid: 27_124,
        image: 'Code',
        className: 'Chrome_WidgetWin_1',
        title: 'Media - VS Code',
      },
    ];
    const count = countOpenWindows({ read, probe: { source: 'os', windows } });
    expect(count.total).toBe(3);
    expect(count.counted).toBe('os');
    expect(count.otherWindows).toBe(2);
    expect(count.forgeWindows).toEqual(['Forge']);
    const refusal = refuseOverCap(count, 3)!;
    expect(refusal).toContain('3 VS Code windows open — Forge, plus 2 other VS Code windows');
    expect(refusal).toContain('Forge cannot close');
  });

  it('counts the window files elsewhere and says that is what it counted', async () => {
    const count = countOpenWindows({
      read: {
        records: [recordFor(ALIVE, 'ws-forge', 'Forge'), recordFor(DEAD, 'ws-strata', 'Strata')],
        unreadable: 0,
        pruned: 0,
      },
      probe: { source: 'unavailable', reason: 'Forge cannot enumerate VS Code windows on linux' },
    });
    expect(count.total).toBe(2);
    expect(count.counted).toBe('files');
    expect(count.otherWindows).toBe(0);
    const refusal = refuseOverCap(count, 2)!;
    expect(refusal).toContain('2 VS Code windows open');
    expect(refusal).toContain('Forge');
    expect(refusal).toContain('Strata');
    expect(refusal).toContain('counted only windows Forge can see');
    expect(refusal).toContain('cannot enumerate VS Code windows on linux');
  });

  it('refuses at the cap and declines to refuse below it', async () => {
    const directory = await windowsDirectory('forge-window-cap-');
    await publishWindowRecord({ directory, record: recordFor(ALIVE, 'ws-forge', 'Forge') });
    const aliases = { other: { path: 'N:\\Other', display_name: 'Other' } };
    const atTheLimit = surfaceFor(directory, { cap: 1, aliases, alive: [ALIVE.pid] });
    expect(await atTheLimit.capRefusal('other')).toContain('1 VS Code windows open');
    expect(await atTheLimit.capRefusal('other')).toContain('The limit is 1');
    const withRoom = surfaceFor(directory, { cap: 2, aliases, alive: [ALIVE.pid] });
    expect(await withRoom.capRefusal('other')).toBeUndefined();
    // A `replace` switch never asks the surface at all, so this is the whole of
    // what the mode check has to get right: it is only ever consulted for
    // `new-window`.
  });

  it('does not refuse a target that is already open in another window', async () => {
    const directory = await windowsDirectory('forge-window-already-');
    // A real folder, because `workspaceIdFor` asks the filesystem for a Windows
    // path's canonical spelling before hashing it.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-window-target-'));
    tempDirs.push(root);
    const target = path.join(root, 'already-open');
    await fs.mkdir(target);
    await publishWindowRecord({
      directory,
      record: recordFor(ALIVE, workspaceIdFor(target), 'AlreadyOpen', { workspacePath: target }),
    });
    const surface = surfaceFor(directory, {
      ownWindowId: DEAD_ID,
      cap: 1,
      aliases: { already: { path: target, display_name: 'AlreadyOpen' } },
      alive: [ALIVE.pid],
    });
    // One window open, cap 1, and the target IS that window: opening it again
    // focuses it and adds no window, so the cap has nothing to refuse for it.
    expect(await surface.capRefusal('already')).toBeUndefined();
    expect(await surface.capRefusal('missing')).toContain('was not found');
  });

  it('refuses to close the window that is answering this phone', async () => {
    const directory = await windowsDirectory('forge-window-selfclose-');
    await publishWindowRecord({ directory, record: recordFor(ALIVE, 'ws-forge', 'Forge') });
    const listed = await surfaceFor(directory, { ownWindowId: ALIVE_ID }).list();
    expect(listed.rows[0]!.closable).toBe(false);
    expect(listed.rows[0]!.whyNotClosable).toContain('answering this phone');
    const asked = await surfaceFor(directory, { ownWindowId: ALIVE_ID }).requestClose(ALIVE_ID, {
      channel: 'telegram',
      chatId: 'chat',
    });
    expect(asked.ok).toBe(false);
    // A row that is not this window is offered a Close, and asking writes a file:
    // nothing here closes anything on its own.
    const other = surfaceFor(directory, { ownWindowId: DEAD_ID, alive: [ALIVE.pid, DEAD.pid] });
    const rows = (await other.list()).rows;
    expect(rows[0]!.closable).toBe(true);
    expect(await other.requestClose(ALIVE_ID, { channel: 'telegram', chatId: 'c' })).toMatchObject({
      ok: true,
    });
    // The request is waiting for the target's own watch, and it is the only thing
    // that changed on disk: asking wrote a file, it did not close a window.
    expect((await readCloseRequest({ directory, windowId: ALIVE_ID })).kind).toBe('request');
    expect((await readCloseRequest({ directory, windowId: ALIVE_ID })).kind).toBe('request');
  });
});
