/**
 * Timers that end early when a signal aborts. Both remove their abort listener
 * whichever way they finish: callers pass long-lived signals (the remote
 * controller's lives as long as the session), and one listener left behind per
 * 250 ms poll is about 14,000 an hour.
 */

/** Resolves after `ms`, or at once when `signal` aborts or already has. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return sleep(ms, signal, undefined);
}

/** Resolves after `ms`; rejects with `abortError()` when `signal` aborts or already has. */
export function sleepOrThrow(
  ms: number,
  signal: AbortSignal | undefined,
  abortError: () => unknown,
): Promise<void> {
  return sleep(ms, signal, abortError);
}

function sleep(
  ms: number,
  signal: AbortSignal | undefined,
  abortError: (() => unknown) | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const settleAborted = (): void => (abortError ? reject(abortError()) : resolve());
    if (signal?.aborted) return settleAborted();
    const onAbort = (): void => {
      clearTimeout(timer);
      settleAborted();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
