import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeOutboxItem } from '../../src/jobs/JobOutbox';
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
