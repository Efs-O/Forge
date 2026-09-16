import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OUTBOX_STALE_MS,
  deleteOutboxItem,
  readOutboxItem,
  readOutboxItems,
  renderOutboxMessage,
  writeOutboxItem,
} from '../../src/jobs/JobOutbox';

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-outbox-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('JobOutbox coalescing (D2)', () => {
  it('a second change for the same job replaces the text and bumps earlier_count', async () => {
    const t0 = 1_000_000;
    await writeOutboxItem(dir, 'llamacpp-releases', 'llama.cpp releases', 'v1', t0);
    await writeOutboxItem(dir, 'llamacpp-releases', 'llama.cpp releases', 'v2', t0 + 1000);

    const item = await readOutboxItem(dir, 'llamacpp-releases');
    expect(item?.text).toBe('v2');
    expect(item?.earlier_count).toBe(1);
    // The item's age is measured from the oldest undelivered change.
    expect(item?.first_undelivered_at).toBe(t0);
    expect(item?.changed_at).toBe(t0 + 1000);
  });

  it('a fresh item starts the count at zero', async () => {
    await writeOutboxItem(dir, 'job', 'Job', 'text', 5);
    const item = await readOutboxItem(dir, 'job');
    expect(item?.earlier_count).toBe(0);
    expect(item?.first_undelivered_at).toBe(5);
  });

  it('a job id with path separators cannot escape the outbox directory', async () => {
    await writeOutboxItem(dir, '../../escape', 'Bad', 'text', 1);
    // The crafted id is sanitized to a single file name inside the dir.
    const entries = await fs.promises.readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain('..');
  });
});

describe('renderOutboxMessage', () => {
  it('a fresh item with no coalesced changes sends the text only', () => {
    const item = {
      job_id: 'j',
      name: 'J',
      text: 'latest release is b10910',
      changed_at: 100,
      earlier_count: 0,
      first_undelivered_at: 100,
    };
    expect(renderOutboxMessage(item, 101)).toBe('latest release is b10910');
  });

  it('a fresh item with coalesced changes appends a count line', () => {
    const item = {
      job_id: 'j',
      name: 'J',
      text: 'latest release is b10910',
      changed_at: 100,
      earlier_count: 3,
      first_undelivered_at: 100,
    };
    expect(renderOutboxMessage(item, 101)).toBe(
      'latest release is b10910\n(+3 earlier changes coalesced)',
    );
  });

  it('an item past 24 h renders as a count only, never the text', () => {
    const item = {
      job_id: 'j',
      name: 'J',
      text: 'should not appear',
      changed_at: 100,
      earlier_count: 5,
      first_undelivered_at: 100,
    };
    const rendered = renderOutboxMessage(item, 100 + OUTBOX_STALE_MS + 1);
    expect(rendered).not.toContain('should not appear');
    expect(rendered).toContain('6 changes');
    expect(rendered).toContain('J');
  });
});

describe('readOutboxItems / deleteOutboxItem', () => {
  it('lists pending items oldest first and skips a corrupt file', async () => {
    await writeOutboxItem(dir, 'a', 'A', 'text', 200);
    await writeOutboxItem(dir, 'b', 'B', 'text', 100);
    // A corrupt item is skipped, not fatal.
    await fs.promises.writeFile(path.join(dir, 'c.json'), '{not json');

    const items = await readOutboxItems(dir);
    expect(items.map((i) => i.job_id)).toEqual(['b', 'a']);
  });

  it('deleteOutboxItem removes the file and is idempotent', async () => {
    await writeOutboxItem(dir, 'a', 'A', 'text', 1);
    await deleteOutboxItem(dir, 'a');
    expect(await readOutboxItem(dir, 'a')).toBeUndefined();
    await expect(deleteOutboxItem(dir, 'a')).resolves.toBeUndefined();
  });
});
