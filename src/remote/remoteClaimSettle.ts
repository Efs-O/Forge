/**
 * A claimed request must reach durable terminal state before the next queued
 * request is claimed. If a disk write fails, keep the same owner/epoch and
 * retry; a window stop leaves it for proven-dead-owner recovery on reload.
 */
export async function settleRemoteClaim(
  write: () => Promise<void>,
  signal: AbortSignal,
  onError: (message: string) => void,
): Promise<boolean> {
  let warned = false;
  let delayMs = 250;
  while (true) {
    try {
      await write();
      return true;
    } catch (err) {
      if (!warned) {
        onError(
          `Forge remote request could not be saved; this conversation's queue is paused ` +
            `while Forge retries the same result: ${err instanceof Error ? err.message : String(err)}`,
        );
        warned = true;
      }
      if (signal.aborted) return false;
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      if (signal.aborted) return false;
      delayMs = Math.min(delayMs * 2, 5_000);
    }
  }
}
