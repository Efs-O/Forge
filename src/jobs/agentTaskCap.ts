import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { ForgeRequestOutcome } from '../sidebar/turnOutcome';
import { sleepOrThrow } from '../util/abortableSleep';

/** The job runner's default timer: resolves after `ms`, or rejects early if `signal` aborts. */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return sleepOrThrow(ms, signal, () => new Error('timer aborted'));
}

/**
 * Steps 5+6: send the prompt, racing it against the optional `max_minutes`
 * cap. On a cap hit, cancels the conversation and reports `timedOut`. The cap
 * timer is aborted on a normal finish so it never outlives the call; on a cap
 * hit the caller waits for the cancellation to settle before clearing the
 * marker and awake hold.
 */
export async function sendWithCap(
  host: ForgeHostFacade,
  conversationId: string,
  prompt: string,
  capMs: number | undefined,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<{ result: ForgeRequestOutcome; timedOut: boolean }> {
  let timedOut = false;
  const capController = capMs !== undefined ? new AbortController() : undefined;
  let capCancelled = false;
  const cap =
    capMs !== undefined
      ? sleep(capMs, capController!.signal)
          .then(async () => {
            if (capCancelled) return;
            timedOut = true;
            await host.cancel(conversationId);
          })
          .catch(() => undefined)
      : undefined;
  let result;
  try {
    result = await host.send(conversationId, prompt);
  } finally {
    if (cap) {
      if (timedOut) {
        // Do not clear the marker or awake hold until cancellation settles.
        await cap;
      } else {
        capCancelled = true;
        capController!.abort();
      }
    }
  }
  return { result, timedOut };
}
