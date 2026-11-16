import { describe, expect, it, vi } from 'vitest';
import {
  MAX_FILE_SETTLE_ROUNDS,
  runWhenFilesSettled,
  snapshotWatchedFiles,
} from '../../src/config/fileSettle';

/** A queue of the waits the helper asked for, run by hand: no real timers. */
function fakeSleep() {
  const pending: Array<() => void> = [];
  return {
    sleep: (_ms: number, run: () => void) => pending.push(run),
    /** Run the oldest pending wait and report how many are left. */
    runNext: () => {
      const next = pending.shift();
      if (!next) throw new Error('no wait was pending');
      next();
      return pending.length;
    },
    waiting: () => pending.length,
  };
}

describe('runWhenFilesSettled', () => {
  it('reads after one quiet window when the files are unchanged', () => {
    const sleep = fakeSleep();
    const onLoad = vi.fn();
    runWhenFilesSettled({
      paths: ['p.yaml'],
      settleMs: 7,
      sleep: sleep.sleep,
      snapshot: () => 'same',
      onLoad,
    });
    expect(onLoad).not.toHaveBeenCalled();
    expect(sleep.waiting()).toBe(1);
    sleep.runNext();
    expect(onLoad).toHaveBeenCalledExactlyOnceWith();
  });

  it('pushes the read back while the file keeps changing, then reads the stable one', () => {
    const sleep = fakeSleep();
    const onLoad = vi.fn();
    // Two flushes in flight: the fingerprint changes once, then stops.
    let fingerprint = 'half-written';
    const snapshot = () => fingerprint;
    runWhenFilesSettled({
      paths: ['p.yaml'],
      settleMs: 5,
      sleep: sleep.sleep,
      snapshot,
      onLoad,
    });
    fingerprint = 'more of the file';
    expect(sleep.runNext()).toBe(1); // saw a change, so it is waiting out another window
    expect(onLoad).not.toHaveBeenCalled();
    fingerprint = 'the whole file';
    expect(sleep.runNext()).toBe(1); // still moving, so the read is pushed back again
    expect(onLoad).not.toHaveBeenCalled();
    sleep.runNext();
    expect(onLoad).toHaveBeenCalledExactlyOnceWith();
  });

  it('still reads a file that never settles, rather than hanging the config', () => {
    const sleep = fakeSleep();
    const onLoad = vi.fn();
    let round = 0;
    runWhenFilesSettled({
      paths: ['p.yaml'],
      settleMs: 1,
      sleep: sleep.sleep,
      snapshot: () => `round ${String(round)}`,
      onLoad,
    });
    for (let attempt = 0; attempt < MAX_FILE_SETTLE_ROUNDS; attempt += 1) {
      round += 1;
      expect(sleep.runNext()).toBeGreaterThan(0);
      expect(onLoad).not.toHaveBeenCalled();
    }
    // The last window is accepted even though the file is still moving: a window
    // with no config at all is the worse failure.
    sleep.runNext();
    expect(onLoad).toHaveBeenCalledExactlyOnceWith();
  });

  it('passes the settle window through, so a test does not wait in real time', () => {
    const sleep = fakeSleep();
    const seen: number[] = [];
    runWhenFilesSettled({
      paths: ['p.yaml'],
      sleep: (ms, run) => {
        seen.push(ms);
        sleep.sleep(ms, run);
      },
      snapshot: () => 'same',
      onLoad: () => {},
    });
    expect(seen).toEqual([200]);
  });

  it('drops the read and stops asking for more once the caller has gone away', () => {
    const sleep = fakeSleep();
    const onLoad = vi.fn();
    let cancelled = false;
    let round = 0;
    runWhenFilesSettled({
      paths: ['p.yaml'],
      settleMs: 1,
      sleep: sleep.sleep,
      snapshot: () => `round ${String(round)}`, // never settles, so every round reschedules
      cancelled: () => cancelled,
      onLoad,
    });
    // Two rounds of a file that keeps moving: still alive, so still waiting.
    round = 1;
    expect(sleep.runNext()).toBe(1);
    round = 2;
    expect(sleep.runNext()).toBe(1);
    expect(onLoad).not.toHaveBeenCalled();
    // The window closes here; the round already waiting must not read, and must not
    // hand itself another round to wait out.
    cancelled = true;
    round = 3;
    expect(sleep.runNext()).toBe(0);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('reads exactly once while the caller is still there', () => {
    const sleep = fakeSleep();
    const onLoad = vi.fn();
    runWhenFilesSettled({
      paths: ['p.yaml'],
      settleMs: 5,
      sleep: sleep.sleep,
      snapshot: () => 'same',
      cancelled: () => false,
      onLoad,
    });
    sleep.runNext();
    expect(onLoad).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('snapshotWatchedFiles', () => {
  it('changes when a watched file grows, which is what a torn read looks like', () => {
    let size = 1_000;
    const stat = () => ({ size, mtimeMs: 100 }) as never;
    const before = snapshotWatchedFiles(['p.yaml'], stat);
    size = 1_500;
    expect(snapshotWatchedFiles(['p.yaml'], stat)).not.toBe(before);
  });

  it('orders the paths, so a reload is not blamed on the watcher firing in another order', () => {
    const stat = () => ({ size: 1, mtimeMs: 1 }) as never;
    expect(snapshotWatchedFiles(['b.yaml', 'a.yaml'], stat)).toBe(
      snapshotWatchedFiles(['a.yaml', 'b.yaml'], stat),
    );
  });

  it('distinguishes a missing file from an empty one', () => {
    const missing = snapshotWatchedFiles(['gone.yaml'], () => {
      throw new Error('ENOENT');
    });
    const empty = snapshotWatchedFiles(['gone.yaml'], () => ({ size: 0, mtimeMs: 0 }) as never);
    expect(missing).toContain('absent');
    expect(missing).not.toBe(empty);
  });
});
