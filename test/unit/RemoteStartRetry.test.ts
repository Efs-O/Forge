import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { RemoteStartRetry } from '../../src/remote/RemoteStartRetry';
import { RemoteLeaseError } from '../../src/remote/RemoteTransportLease';

/**
 * A failed remote start used to end in a toast and silence until a manual
 * reload. The retry must back off, stop once the runtime no longer wants the
 * start, and never fire for a lease refusal: in a two-window setup losing the
 * lease is normal, and retrying it would loop forever in the second window.
 */

const config = {} as ForgeConfig;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function harness(startResults: Array<Error | undefined>, wanted = () => true) {
  const start = vi.fn(async () => {
    const result = startResults.shift();
    if (result) throw result;
  });
  const retry = new RemoteStartRetry({ serialize: (task) => task(), wanted, start });
  return { retry, start };
}

describe('RemoteStartRetry', () => {
  it('never retries a lease refusal', async () => {
    const { retry, start } = harness([]);
    retry.failed(config, new RemoteLeaseError('held by another window'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(start).not.toHaveBeenCalled();
  });

  it('backs off 5 s, 15 s, then 60 s while the start keeps failing', async () => {
    const failure = new Error('Forge remote state lock timed out');
    const { retry, start } = harness([failure, failure, failure, undefined]);
    retry.failed(config, failure);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(start).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(start).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(start).toHaveBeenCalledTimes(4);
  });

  it('stops retrying once a lease refusal follows a lock failure', async () => {
    const { retry, start } = harness([new RemoteLeaseError('another window took it')]);
    retry.failed(config, new Error('lock timed out'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('skips the start when the runtime no longer wants it, and cancel clears the timer', async () => {
    let wanted = true;
    const { retry, start } = harness([], () => wanted);
    retry.failed(config, new Error('boom'));
    wanted = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(start).not.toHaveBeenCalled();

    wanted = true;
    retry.failed(config, new Error('boom'));
    retry.cancel();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(start).not.toHaveBeenCalled();
  });
});
