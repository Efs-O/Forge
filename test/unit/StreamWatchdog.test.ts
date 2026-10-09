import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FIRST_BYTE_STALL_TIMEOUT_MS,
  STREAM_STALL_CEILING_MS,
  STREAM_STALL_TIMEOUT_MS,
  StreamStallError,
  StreamWatchdog,
  type StallProbeAnswer,
} from '../../src/llm/streamWatchdog';

describe('StreamWatchdog stall probes', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps a silent stream open while the server is alive, then probes again', async () => {
    vi.useFakeTimers();
    const probe = vi.fn<() => Promise<StallProbeAnswer>>()
      .mockResolvedValueOnce('alive').mockResolvedValueOnce('not-alive');
    const onStalled = vi.fn();
    const watchdog = new StreamWatchdog('test', Date.now(), () => '', vi.fn(), onStalled, probe);
    watchdog.activity();
    watchdog.delta('tool_args');
    await vi.advanceTimersByTimeAsync(STREAM_STALL_TIMEOUT_MS + 15_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onStalled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(STREAM_STALL_TIMEOUT_MS + 15_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onStalled).toHaveBeenCalledOnce();
    expect(onStalled.mock.calls[0]?.[0]).toBeInstanceOf(StreamStallError);
    const stall = (onStalled.mock.calls[0]?.[0] as StreamStallError).stall;
    expect(stall).toMatchObject({
      last_delta_kind: 'tool_args',
      last_delta_ms: 0,
    });
    expect(stall.idle_ms).toBeGreaterThanOrEqual(STREAM_STALL_TIMEOUT_MS * 2);
    watchdog.stop();
  });

  it.each(['not-alive', 'error: offline', 'skipped: not loopback'] as const)(
    'ends a stream when the probe returns %s', async (answer) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const onStalled = vi.fn();
      const watchdog = new StreamWatchdog(
        'test', Date.now(), () => '', cancel, onStalled, async () => answer,
      );
      watchdog.activity();
      await vi.advanceTimersByTimeAsync(STREAM_STALL_TIMEOUT_MS + 15_000);
      expect(cancel).toHaveBeenCalledOnce();
      expect((onStalled.mock.calls[0]?.[0] as StreamStallError).stall.probe).toBe(answer);
      watchdog.stop();
    },
  );

  it('enforces the total silence ceiling even while probes report alive', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => 'alive' as const);
    const onStalled = vi.fn();
    const watchdog = new StreamWatchdog('test', Date.now(), () => '', vi.fn(), onStalled, probe);
    watchdog.activity();
    await vi.advanceTimersByTimeAsync(STREAM_STALL_CEILING_MS + 15_000);
    expect(onStalled).toHaveBeenCalledOnce();
    expect((onStalled.mock.calls[0]?.[0] as StreamStallError).stall.idle_ms).toBeGreaterThanOrEqual(
      STREAM_STALL_CEILING_MS,
    );
    watchdog.stop();
  });

  it('labels an unprobed timeout without claiming the server was queried', async () => {
    vi.useFakeTimers();
    const onStalled = vi.fn();
    const watchdog = new StreamWatchdog('ollama', Date.now(), () => '', vi.fn(), onStalled);
    watchdog.activity();
    await vi.advanceTimersByTimeAsync(STREAM_STALL_TIMEOUT_MS);
    expect((onStalled.mock.calls[0]?.[0] as StreamStallError).stall.probe).toBe(
      'skipped: no probe',
    );
    watchdog.stop();
  });

  it('uses the longer first-byte budget and ignores a probe resolving after stop', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<StallProbeAnswer>();
    const probe = vi.fn(() => pending.promise);
    const onStalled = vi.fn();
    const watchdog = new StreamWatchdog('test', Date.now(), () => '', vi.fn(), onStalled, probe);
    await vi.advanceTimersByTimeAsync(FIRST_BYTE_STALL_TIMEOUT_MS + 15_000);
    expect(probe).toHaveBeenCalledOnce();
    watchdog.stop();
    pending.resolve('not-alive');
    await vi.runAllTimersAsync();
    expect(onStalled).not.toHaveBeenCalled();
  });

  it('ignores a probe answer when bytes arrived while it was pending', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<StallProbeAnswer>();
    const onStalled = vi.fn();
    const watchdog = new StreamWatchdog(
      'test', Date.now(), () => '', vi.fn(), onStalled, () => pending.promise,
    );
    watchdog.activity();
    await vi.advanceTimersByTimeAsync(STREAM_STALL_TIMEOUT_MS);
    watchdog.activity();
    pending.resolve('not-alive');
    await vi.advanceTimersByTimeAsync(1);
    expect(onStalled).not.toHaveBeenCalled();
    watchdog.stop();
  });
});
