import { describe, expect, it, vi } from 'vitest';
import { MAX_WAIT_SECONDS, makeWaitTool } from '../../src/tools/waitTool';

const tool = makeWaitTool();
const ctx = (signal?: AbortSignal) => ({
  beforeMutate: () => {},
  ...(signal ? { abortSignal: signal } : {}),
});

describe('wait tool', () => {
  it('waits about as long as asked and reports the measured time', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      const pending = tool.handler({ seconds: 1 }, ctx());
      let settled = false;
      void pending.then(() => (settled = true));

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatch(/^Waited 1s\. Local time is now \d{2}:\d{2}\.$/u);
      expect(Date.now()).toBe(Date.parse('2026-01-01T12:00:01Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  // /stop must not leave a turn parked on a timer.
  it('returns as soon as the turn is aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = tool.handler({ seconds: MAX_WAIT_SECONDS }, ctx(controller.signal));
    try {
      await vi.advanceTimersByTimeAsync(50);
      controller.abort();
      await expect(pending).resolves.toContain('Wait cancelled after 0s');
      await expect(pending).resolves.toContain(`of the ${MAX_WAIT_SECONDS}s requested`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns immediately when the turn is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    const result = await tool.handler({ seconds: MAX_WAIT_SECONDS }, ctx(controller.signal));
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result).toContain('Wait cancelled');
  });

  it('rejects invalid values and clamps an overlong wait with a visible note', async () => {
    await expect(tool.handler({ seconds: 0 }, ctx())).rejects.toThrow(
      new RegExp(`1 to ${MAX_WAIT_SECONDS}`, 'u'),
    );
    await expect(tool.handler({ seconds: 1.5 }, ctx())).rejects.toThrow(/whole number/u);
    const controller = new AbortController();
    const pending = tool.handler({ seconds: MAX_WAIT_SECONDS + 1 }, ctx(controller.signal));
    controller.abort();
    await expect(pending).resolves.toContain(`seconds clamped to ${MAX_WAIT_SECONDS}`);
  });

  it('takes no free-form blob arg', () => {
    const schema = tool.definition.function.parameters;
    expect(schema).toMatchObject({ required: ['seconds'], additionalProperties: false });
    expect(Object.keys((schema as { properties: object }).properties)).toEqual(['seconds']);
  });

  it('points at monitor_execution for waiting on a command', () => {
    expect(tool.definition.function.description).toContain('monitor_execution');
  });

  // The 2026-09-05 miscount: two wait(360) calls reported as a 60-minute check.
  // A duration alone gives no position in time, so the model can only count its
  // own sleeps, and it cannot see a miscount from the inside.
  it('reports the wall clock so an interval can be timed against it', () => {
    expect(tool.definition.function.description).toContain('local wall-clock time');
    expect(tool.definition.function.description).toContain(`an hour is four calls of ${MAX_WAIT_SECONDS}s`);
  });
});
