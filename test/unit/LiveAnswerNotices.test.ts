import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deliverLiveAnswerNotice,
  formatLiveAnswerNotice,
  LiveAnswerNotices,
  MAX_PENDING_LIVE_ASKS,
  type LiveAnswerNotice,
} from '../../src/agentBus/liveAnswerNotices';

interface Deferred {
  promise: Promise<string>;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve!: (text: string) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const opts = (id: string, settle: (signal: AbortSignal) => Promise<string>) => ({
  id,
  conversationId: 'c1',
  who: 'Claude',
  subject: 'Does X hold?',
  settle,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => vi.useRealTimers());

describe('LiveAnswerNotices', () => {
  it('notifies exactly once when the answer lands', async () => {
    const notices = new LiveAnswerNotices();
    const got: LiveAnswerNotice[] = [];
    notices.onAnswer((n) => got.push(n));
    const d = deferred();
    notices.defer(opts('q1', () => d.promise));
    expect(notices.pendingCount).toBe(1);
    d.resolve('Yes.');
    await flush();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: 'q1', conversationId: 'c1', text: 'Yes.' });
    expect(notices.pendingCount).toBe(0);
  });

  it('notifies nothing after dispose()', async () => {
    const notices = new LiveAnswerNotices();
    const got: LiveAnswerNotice[] = [];
    notices.onAnswer((n) => got.push(n));
    const d = deferred();
    let seen: AbortSignal | undefined;
    notices.defer(
      opts('q1', (signal) => {
        seen = signal;
        return d.promise;
      }),
    );
    notices.dispose();
    expect(seen?.aborted).toBe(true);
    d.resolve('too late');
    await flush();
    expect(got).toEqual([]);
  });

  it('reports a timeout once, with the timeout text', async () => {
    vi.useFakeTimers();
    const notices = new LiveAnswerNotices();
    const got: LiveAnswerNotice[] = [];
    notices.onAnswer((n) => got.push(n));
    notices.defer({
      ...opts(
        'q1',
        (signal) =>
          new Promise<string>((resolve) =>
            signal.addEventListener('abort', () => resolve('Stopped before Claude answered.')),
          ),
      ),
      abortAfterMs: 1_000,
      timeoutText: 'No answer within 1 min.',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('No answer within 1 min.');
  });

  it('turns a rejected wait into a failure notice, not an unhandled rejection', async () => {
    const notices = new LiveAnswerNotices();
    const got: LiveAnswerNotice[] = [];
    notices.onAnswer((n) => got.push(n));
    const d = deferred();
    notices.defer(opts('q1', () => d.promise));
    d.reject(new Error('pipe closed'));
    await flush();
    expect(got[0].text).toBe('Claude could not answer: pipe closed');
  });

  it('caps pending questions and refuses without a listener', () => {
    const notices = new LiveAnswerNotices();
    expect(() => notices.assertCanDefer()).toThrow(/no chat is listening/);
    notices.onAnswer(() => undefined);
    for (let i = 0; i < MAX_PENDING_LIVE_ASKS; i++) {
      notices.defer(opts(`q${i}`, () => new Promise<string>(() => undefined)));
    }
    expect(() => notices.assertCanDefer()).toThrow(/already waiting/);
    notices.dispose();
  });
});

describe('deliverLiveAnswerNotice', () => {
  const notice: LiveAnswerNotice = {
    id: 'q1',
    conversationId: 'c1',
    who: 'Claude',
    subject: 'Does X hold?',
    text: 'Yes.',
  };

  it('routes an internal notice that says it is not from the user', () => {
    const route = vi.fn();
    deliverLiveAnswerNotice(notice, () => true, route, vi.fn());
    expect(route).toHaveBeenCalledOnce();
    const [text, id, echo, internal] = route.mock.calls[0] as [string, string, boolean, boolean];
    expect(text).toBe(formatLiveAnswerNotice(notice));
    expect(text).toContain('not a message from the user');
    expect(text).toContain('not instructions');
    expect([id, echo, internal]).toEqual(['c1', false, true]);
  });

  it('drops the notice with one log line when the chat is gone', () => {
    const route = vi.fn();
    const log = vi.fn();
    deliverLiveAnswerNotice(notice, () => false, route, log);
    expect(route).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });
});
