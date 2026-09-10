import { z } from 'zod';

/**
 * Telegram's own rate-limit reply. `retry_after` is seconds, and it is the only
 * authoritative answer to "how long" -- guessing a backoff instead is what turns
 * one throttled send into a burst of throttled sends.
 */
const TelegramResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().nonnegative().optional() }).optional(),
});

const RATE_LIMIT_STATUS = 429;
/** Bounded: a chat being throttled indefinitely must surface, not stall forever. */
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60_000;

type Fetch = typeof fetch;

/**
 * One FIFO lane per chat for everything Forge sends to Telegram.
 *
 * Order used to be a race. Several independent producers write to the same
 * chat -- the durable outbox loop (with its own 1s-to-60s retry backoff), the
 * live progress channel's narration and warning sends, command replies,
 * approval prompts, `/view`, selection pages -- and each was orderly only
 * within itself. Two `sendMessage` calls in flight at once are ordered by
 * whichever reaches Telegram's server first, so an older message could and did
 * land after a newer one. Shipping mid-turn narration (0.15.33) raised the
 * volume from roughly one message per turn to one per round and made the race
 * routine rather than theoretical.
 *
 * This is the one chokepoint every producer already passes through, so
 * serializing here fixes all of them without a single caller change. Calls with
 * no `chat_id` -- `getUpdates`' long poll above all -- are deliberately not
 * queued: they address no chat, and putting the poll behind a slow send would
 * stall inbound traffic.
 */
export class TelegramChatQueue {
  private readonly lanes = new Map<string, Promise<unknown>>();

  run<T>(chatId: string | undefined, task: () => Promise<T>): Promise<T> {
    if (chatId === undefined) return task();
    // The stored tail never rejects, so one failed send cannot poison the lane
    // behind it. The caller still gets the real rejection from `result`.
    const previous = this.lanes.get(chatId) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(chatId, tail);
    void tail.then(() => {
      // Only the lane's own tail clears it: a later send has already replaced
      // this entry, and deleting it then would let the next call jump the lane.
      if (this.lanes.get(chatId) === tail) this.lanes.delete(chatId);
    });
    return result;
  }

  /** Chats with a send still in flight or queued. Test and diagnostic use. */
  get pendingChats(): number {
    return this.lanes.size;
  }
}

/**
 * One Bot API call, honouring `retry_after` on a 429.
 *
 * The previous behaviour threw on any non-2xx, which for a rate limit meant the
 * outbox retried it on its own escalating schedule -- landing the message out of
 * order -- while a narration or warning was simply logged and lost. Waiting the
 * interval Telegram names and retrying in place keeps the message, and keeps it
 * in its lane.
 */
export async function postTelegram(
  fetchImpl: Fetch,
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const parsed = safeParse(await readJson(response));
    if (response.status === RATE_LIMIT_STATUS && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfterMs = Math.min(
        Math.max(parsed?.parameters?.retry_after ?? 1, 1) * 1_000,
        MAX_RETRY_AFTER_MS,
      );
      await sleep(retryAfterMs, signal);
      continue;
    }
    if (!response.ok) throw new Error(`Telegram Bot API HTTP ${response.status}.`);
    if (!parsed) throw new Error(`Telegram Bot API returned an unreadable ${method} response.`);
    if (!parsed.ok) throw new Error(`Telegram Bot API rejected ${method}.`);
    return parsed.result;
  }
}

/** A throttled or failed call can carry a non-JSON body; that is not an error
 *  worth masking the HTTP status with. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function safeParse(payload: unknown): z.infer<typeof TelegramResponseSchema> | undefined {
  const parsed = TelegramResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Telegram send aborted while rate-limited.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('Telegram send aborted while rate-limited.'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
