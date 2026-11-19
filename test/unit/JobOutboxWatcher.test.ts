import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_STALE_MS, writeOutboxItem } from '../../src/jobs/JobOutbox';
import { JobOutboxWatcher } from '../../src/remote/JobOutboxWatcher';

let dir: string;
let delivered: string[];
let deliverResult: number;

function makeWatcher(): JobOutboxWatcher {
  return new JobOutboxWatcher({
    outboxDir: dir,
    deliver: async (text) => {
      delivered.push(text);
      return deliverResult;
    },
    now: () => 1000,
  });
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-watcher-'));
  delivered = [];
  deliverResult = 1;
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('JobOutboxWatcher (B.4 delivery route)', () => {
  it('does not create a watcher when stop races the directory creation', async () => {
    let release!: () => void;
    const mkdirPending = new Promise<void>((resolve) => (release = resolve));
    const watch = vi.fn(() => ({ close: vi.fn() }) as unknown as fs.FSWatcher);
    const watcher = new JobOutboxWatcher({
      outboxDir: dir,
      deliver: async (text) => {
        delivered.push(text);
        return deliverResult;
      },
      now: () => 1000,
      mkdir: async () => mkdirPending,
      watch,
    });

    watcher.start();
    watcher.stop();
    release();
    await mkdirPending;
    await new Promise((resolve) => setImmediate(resolve));

    expect(watch).not.toHaveBeenCalled();
  });

  it('does not deliver later items after stop and leaves them on disk', async () => {
    await writeOutboxItem(dir, 'a', 'A', 'first', 1);
    await writeOutboxItem(dir, 'b', 'B', 'second', 2);
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const deliveryStarted = new Promise<void>((resolve) => (started = resolve));
    const watcher = new JobOutboxWatcher({
      outboxDir: dir,
      deliver: async (text) => {
        delivered.push(text);
        started();
        await pending;
        return 1;
      },
      now: () => 1000,
    });

    const draining = watcher.drain();
    await deliveryStarted;
    watcher.stop();
    release();
    await draining;

    expect(delivered).toHaveLength(1);
    expect(await fs.promises.readdir(dir)).toContain('b.json');
  });

  it('delivers the remaining items when restarted while a stopped pass was in flight', async () => {
    await writeOutboxItem(dir, 'a', 'A', 'first', 1);
    await writeOutboxItem(dir, 'b', 'B', 'second', 2);
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const deliveryStarted = new Promise<void>((resolve) => (started = resolve));
    const watcher = new JobOutboxWatcher({
      outboxDir: dir,
      deliver: async (text) => {
        delivered.push(text);
        started();
        await pending;
        return 1;
      },
      now: () => 1000,
      debounceMs: 0,
      watch: () => ({ close: vi.fn() }) as unknown as fs.FSWatcher,
    });

    const draining = watcher.drain();
    await deliveryStarted;
    watcher.stop();
    // The new start's own drain is refused while the old pass still runs.
    watcher.start();
    release();
    await draining;

    await vi.waitFor(async () => expect(await fs.promises.readdir(dir)).toEqual([]));
    expect(delivered).toHaveLength(2);
    watcher.stop();
  });

  it('keeps a change written while the delivery was in flight', async () => {
    await writeOutboxItem(dir, 'j', 'J', 'first', 1);
    // Delivery is not instantaneous. Coalescing keeps one file per job, so a
    // newer change lands on the very file the watcher is about to unlink — a
    // blind delete-by-id would drop a change nothing ever counted.
    const watcher = new JobOutboxWatcher({
      outboxDir: dir,
      deliver: async (text) => {
        delivered.push(text);
        await writeOutboxItem(dir, 'j', 'J', 'second', 2);
        return 1;
      },
      now: () => 1000,
    });

    await watcher.drain();

    expect(delivered).toEqual(['first']);
    const files = await fs.promises.readdir(dir);
    expect(files).toContain('j.json');
    const kept = JSON.parse(await fs.promises.readFile(path.join(dir, 'j.json'), 'utf8')) as {
      text: string;
    };
    expect(kept.text).toBe('second');

    // And the next drain delivers it rather than losing it. (It carries the
    // coalescing suffix: the second write bumped `earlier_count`, which is the
    // existing counter's behaviour, not something this fix changes.)
    await watcher.drain();
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toContain('second');
  });

  it('hands a stranded hand-off back to the pending set before delivering', async () => {
    // A delivery whose process died between its claim and its settle leaves the
    // job's newest change in a file no drain reads. Without the reclaim step in
    // the pass, that change waits out the TTL and may never reach its chat.
    const claim = path.join(dir, 'j.json.claim-00000000-0000-4000-8000-000000000000');
    fs.writeFileSync(
      claim,
      JSON.stringify({
        job_id: 'j',
        name: 'J',
        text: 'stranded',
        changed_at: 5,
        earlier_count: 0,
        first_undelivered_at: 5,
      }),
    );
    const stale = new Date(Date.now() - CLAIM_STALE_MS - 60_000);
    fs.utimesSync(claim, stale, stale);

    await makeWatcher().drain();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('stranded');
    // Delivered and settled: neither the claim nor the item is left behind.
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it('deletes a file only after delivery is accepted (reached > 0)', async () => {
    await writeOutboxItem(dir, 'j', 'J', 'hello', 1);
    const watcher = makeWatcher();
    await watcher.drain();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('hello');
    // The file is gone because delivery was accepted.
    const files = await fs.promises.readdir(dir);
    expect(files).not.toContain('j.json');
  });

  it('a conversation-less notify (reached 0) keeps the file pending', async () => {
    await writeOutboxItem(dir, 'j', 'J', 'hello', 1);
    deliverResult = 0;
    const watcher = makeWatcher();
    await watcher.drain();

    // Delivery was attempted but reached no chat; the file stays for retry.
    expect(delivered).toHaveLength(1);
    const files = await fs.promises.readdir(dir);
    expect(files).toContain('j.json');
  });

  it('a delivery error counts as not delivered and keeps the file', async () => {
    await writeOutboxItem(dir, 'j', 'J', 'hello', 1);
    const watcher = new JobOutboxWatcher({
      outboxDir: dir,
      deliver: async () => {
        throw new Error('transport down');
      },
      now: () => 1000,
    });
    await watcher.drain();
    const files = await fs.promises.readdir(dir);
    expect(files).toContain('j.json');
  });

  it('delivers items oldest first in one pass', async () => {
    await writeOutboxItem(dir, 'a', 'A', 'first', 100);
    await writeOutboxItem(dir, 'b', 'B', 'second', 50);
    const watcher = makeWatcher();
    await watcher.drain();

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toContain('second');
    expect(delivered[1]).toContain('first');
  });
});
