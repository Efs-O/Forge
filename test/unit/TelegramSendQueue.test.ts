import { describe, expect, it, vi } from 'vitest';
import { postTelegram, TelegramChatQueue } from '../../src/remote/telegramSendQueue';
import { TelegramChannel } from '../../src/remote/TelegramChannel';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('TelegramChatQueue', () => {
  it('keeps one chat in call order even when an earlier send is slow', async () => {
    const queue = new TelegramChatQueue();
    const done: string[] = [];
    const first = deferred<void>();

    const a = queue.run('chat', async () => {
      await first.promise;
      done.push('a');
    });
    const b = queue.run('chat', async () => {
      done.push('b');
    });

    // `b` is ready to run immediately and must still wait for `a`.
    await Promise.resolve();
    expect(done).toEqual([]);
    first.resolve();
    await Promise.all([a, b]);
    expect(done).toEqual(['a', 'b']);
  });

  it('does not let one chat block another, and clears its lane when idle', async () => {
    const queue = new TelegramChatQueue();
    const done: string[] = [];
    const blocked = deferred<void>();

    const slow = queue.run('chat-a', async () => {
      await blocked.promise;
      done.push('a');
    });
    await queue.run('chat-b', async () => {
      done.push('b');
    });

    expect(done).toEqual(['b']);
    blocked.resolve();
    await slow;
    expect(done).toEqual(['b', 'a']);
    // The lane clears itself a microtask after the caller's promise settles.
    await vi.waitFor(() => expect(queue.pendingChats).toBe(0));
  });

  it('does not poison a lane when a send fails', async () => {
    const queue = new TelegramChatQueue();
    const failed = queue.run('chat', async () => {
      throw new Error('offline');
    });
    await expect(failed).rejects.toThrow('offline');
    await expect(queue.run('chat', async () => 'next')).resolves.toBe('next');
  });

  it('runs an unqueued call without a chat immediately', async () => {
    const queue = new TelegramChatQueue();
    const blocked = deferred<void>();
    void queue.run('chat', () => blocked.promise);
    await expect(queue.run(undefined, async () => 'poll')).resolves.toBe('poll');
    blocked.resolve();
  });
});

describe('postTelegram', () => {
  it('waits the interval Telegram names on a 429, then delivers the same message', async () => {
    vi.useFakeTimers();
    try {
      const bodies: string[] = [];
      let attempts = 0;
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body));
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 5 } }, 429)
          : jsonResponse({ ok: true, result: { message_id: 7 } });
      }) as typeof fetch;

      const call = postTelegram(fetchImpl, 'token', 'sendMessage', { chat_id: '1', text: 'hi' });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(call).resolves.toEqual({ message_id: 7 });
      // Retried in place, so the message is neither lost nor re-ordered.
      expect(bodies).toHaveLength(2);
      expect(JSON.parse(bodies[1]!)).toEqual({ chat_id: '1', text: 'hi' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up with the HTTP status once the bounded retries are spent', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = (async () =>
        jsonResponse({ ok: false, parameters: { retry_after: 1 } }, 429)) as typeof fetch;
      const call = postTelegram(fetchImpl, 'token', 'sendMessage', { chat_id: '1' });
      const assertion = expect(call).rejects.toThrow('Telegram Bot API HTTP 429.');
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TelegramChannel ordering', () => {
  it('sends to one chat in call order even when the first request is slow', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const first = deferred<void>();
    const channel = new TelegramChannel({
      token: 'token',
      getCursor: () => undefined,
      setCursor: async () => undefined,
      fetch: (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { text?: string };
        started.push(body.text ?? '');
        if (body.text === 'older') await first.promise;
        finished.push(body.text ?? '');
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      }) as typeof fetch,
    });

    const older = channel.send('chat', 'older');
    const newer = channel.send('chat', 'newer');
    await Promise.resolve();
    // The newer send must not even reach the network until the older one lands.
    expect(started).toEqual(['older']);
    first.resolve();
    await Promise.all([older, newer]);
    expect(finished).toEqual(['older', 'newer']);
  });
});
