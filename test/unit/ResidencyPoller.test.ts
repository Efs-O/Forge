import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResidencyPoller } from '../../src/sidebar/ResidencyPoller';

describe('ResidencyPoller refresh hook', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts refreshes at the configured interval without overlapping', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const finish: Array<() => void> = [];
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => finish.push(resolve)),
    );
    const poller = new ResidencyPoller(() => '', vi.fn(), 1_500, refresh, 10_000);
    poller.start();

    await vi.advanceTimersByTimeAsync(10_500);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(refresh).toHaveBeenCalledOnce();

    finish[0]?.();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(2);
    poller.stop();
    finish[1]?.();
  });

  it('does not start a refresh after the poller stops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const refresh = vi.fn(async () => {});
    const poller = new ResidencyPoller(() => '', vi.fn(), 1_500, refresh, 10_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(9_000);
    poller.stop();

    await vi.advanceTimersByTimeAsync(12_000);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('logs a rejected refresh and keeps polling for the next interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);
    const poller = new ResidencyPoller(() => '', vi.fn(), 1_500, refresh, 10_000);
    poller.start();

    await vi.advanceTimersByTimeAsync(10_500);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(refresh).toHaveBeenCalledTimes(2);

    poller.stop();
  });
});
