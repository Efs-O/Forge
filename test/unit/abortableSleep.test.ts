import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortableSleep, sleepOrThrow } from '../../src/util/abortableSleep';

/** Counts the abort listeners still attached, which is what C-03 leaked. */
function trackedSignal(): { signal: AbortSignal; abort: () => void; listeners: () => number } {
  const controller = new AbortController();
  const live = new Set<unknown>();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, fn, opts) => {
    live.add(fn);
    add(type, fn, opts);
  });
  vi.spyOn(controller.signal, 'removeEventListener').mockImplementation((type, fn, opts) => {
    live.delete(fn);
    remove(type, fn, opts);
  });
  return { signal: controller.signal, abort: () => controller.abort(), listeners: () => live.size };
}

describe('abortableSleep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('leaves no listener on a long-lived signal after the timer fires (C-03)', async () => {
    const tracked = trackedSignal();
    for (let i = 0; i < 3; i++) {
      const slept = abortableSleep(250, tracked.signal);
      await vi.advanceTimersByTimeAsync(250);
      await slept;
    }
    expect(tracked.listeners()).toBe(0);
  });

  it('resolves early on abort, and at once on a signal that already aborted', async () => {
    const controller = new AbortController();
    const slept = abortableSleep(60_000, controller.signal);
    controller.abort();
    await expect(slept).resolves.toBeUndefined();
    await expect(abortableSleep(60_000, controller.signal)).resolves.toBeUndefined();
  });

  it('sleepOrThrow rejects with the caller’s error on abort and resolves otherwise', async () => {
    const tracked = trackedSignal();
    const done = sleepOrThrow(100, tracked.signal, () => new Error('stopped'));
    await vi.advanceTimersByTimeAsync(100);
    await expect(done).resolves.toBeUndefined();
    expect(tracked.listeners()).toBe(0);

    const stopped = sleepOrThrow(100, tracked.signal, () => new Error('stopped'));
    tracked.abort();
    await expect(stopped).rejects.toThrow('stopped');
    await expect(sleepOrThrow(100, tracked.signal, () => new Error('late'))).rejects.toThrow(
      'late',
    );
  });
});
