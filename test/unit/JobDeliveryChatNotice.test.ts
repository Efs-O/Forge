import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobDelivery } from '../../src/jobs/JobDelivery';
import type { Job } from '../../src/jobs/jobSchema';

/**
 * A job's reports went to Telegram and to a toast, and nowhere else. The window
 * the owner reads showed nothing, so a nightly job that switched and rolled
 * itself back looked indistinguishable from a job that never ran.
 *
 * `deliver` now draws the same fact in the job's own chat (`state.conversation_id`)
 * as a notice row: no model turn, no chat opened, and nothing at all when that
 * chat has never been opened or lives in another window. The outbox stays the
 * durable record — the notice is the local half, and it goes first so a Telegram
 * failure still leaves the window told.
 */
let outboxDir: string;
let toasts: string[];
let notices: Array<{ conversationId: string; text: string }>;

beforeEach(() => {
  outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-deliver-chat-'));
  toasts = [];
  notices = [];
});
afterEach(() => {
  fs.rmSync(outboxDir, { recursive: true, force: true });
});

const job = {
  id: 'llama-updates',
  name: 'llama-updates',
  enabled: true,
  schedule: { kind: 'daily', at: '06:15' },
  check: { kind: 'none' },
  on_change: { kind: 'notify' },
} as unknown as Job;

/** The job store, answering with the state whose chat id is `conversationId`. */
const storeWith = (conversationId: string | null) => ({
  load: async () => ({ job, state: { conversation_id: conversationId } }),
});

function delivery(
  store: unknown,
  post: (conversationId: string, text: string) => void = (conversationId, text) =>
    notices.push({ conversationId, text }),
): JobDelivery {
  return new JobDelivery({
    store: store as never,
    outboxDir,
    notifyLocal: (text) => toasts.push(text),
    postToJobChat: post,
    busy: () => undefined,
    now: () => Date.parse('2026-11-18T04:15:00Z'),
  });
}

const outboxFiles = (): string[] =>
  fs
    .readdirSync(outboxDir, { recursive: true, withFileTypes: true })
    .flatMap((entry) => (entry.isFile() ? [entry.name] : []));

describe('a job report in the job’s own chat', () => {
  it('draws the report there with the same words the toast and Telegram get', async () => {
    await delivery(storeWith('chat-7')).deliver(job, 'b12497 staged; switching when idle');

    expect(notices).toEqual([
      {
        conversationId: 'chat-7',
        text: 'Job "llama-updates": b12497 staged; switching when idle',
      },
    ]);
    // One fact, one wording: the window, the toast and the phone must not differ.
    expect(toasts[0]).toBe(notices[0]?.text);
    expect(outboxFiles().length).toBe(1);
  });

  it('shows nothing when the job has never had a discuss chat', async () => {
    await delivery(storeWith(null)).deliver(job, 'free space dropped');

    expect(notices).toEqual([]);
    expect(outboxFiles().length).toBe(1);
  });

  it('shows nothing when the job was deleted mid-run', async () => {
    await delivery({ load: async () => undefined }).deliver(job, 'free space dropped');

    expect(notices).toEqual([]);
    expect(outboxFiles().length).toBe(1);
  });

  it('still delivers when the chat cannot be drawn: the notice is not the record', async () => {
    const d = delivery(storeWith('chat-7'), () => {
      throw new Error('no such chat in this window');
    });

    expect(await d.tryDeliver(job, 'post-check failed after switching to b12497')).toBe(1);
    expect(toasts.length).toBe(1);
    expect(outboxFiles().length).toBe(1);
  });

  it('is not asked when nothing wires it (a scheduler with no sidebar)', async () => {
    const d = new JobDelivery({
      store: storeWith('chat-7') as never,
      outboxDir,
      notifyLocal: (text: string) => toasts.push(text),
      busy: () => undefined,
      now: () => Date.parse('2026-11-18T04:15:00Z'),
    });

    await d.deliver(job, 'free space dropped');

    expect(notices).toEqual([]);
    expect(outboxFiles().length).toBe(1);
  });

  it('reaches the chat before the outbox, so a Telegram failure still tells the window', async () => {
    let outboxWasWritten: boolean | undefined;
    const d = new JobDelivery({
      store: storeWith('chat-7') as never,
      outboxDir,
      notifyLocal: (text) => toasts.push(text),
      postToJobChat: (conversationId, text) => {
        outboxWasWritten = outboxFiles().length > 0;
        notices.push({ conversationId, text });
      },
      busy: () => undefined,
      now: () => Date.parse('2026-11-18T04:15:00Z'),
    });

    await d.deliver(job, 'free space dropped');

    // The notice goes first: when the outbox write throws, the window was told anyway.
    expect(outboxWasWritten).toBe(false);
    expect(notices.length).toBe(1);
  });
});
