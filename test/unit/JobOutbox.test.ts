import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAIM_STALE_MS,
  OUTBOX_STALE_MS,
  deleteOutboxItem,
  readOutboxItem,
  readOutboxItems,
  reclaimOutboxClaims,
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

describe('deleteOutboxItem claims the hand-off', () => {
  const CLAIM_TOKEN = '00000000-0000-4000-8000-000000000000';
  const claimFile = (jobId = 'job') =>
    path.join(dir, `${jobId}.json.claim-${CLAIM_TOKEN}`);

  const writeClaim = (changedAt: number, text = 'claimed text'): void => {
    fs.writeFileSync(
      claimFile(),
        JSON.stringify({
        job_id: 'job',
        name: 'Job',
        text,
        changed_at: changedAt,
        earlier_count: 0,
        first_undelivered_at: changedAt,
      }),
    );
  };

  it('settles a delivered item and leaves no claim behind', async () => {
    await writeOutboxItem(dir, 'job', 'Job', 'text', 1000);
    await deleteOutboxItem(dir, 'job', 1000);
    expect(await readOutboxItem(dir, 'job')).toBeUndefined();
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it('a change written while the hand-off is in flight survives the delete', async () => {
    const t0 = 1_000_000;
    await writeOutboxItem(dir, 'job', 'Job', 'delivered text', t0);
    // The window the old compare-then-unlink lost: the scheduler coalescing a
    // newer change for the same job while this delivery holds the file. The
    // claim moves the delivered bytes out of the way first, so the newer change
    // lands on a fresh file the settle cannot remove.
    const real = fs.promises.rename.bind(fs.promises);
    let injected = false;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await real(from, to);
      if (!injected && String(to).includes('.claim-')) {
        injected = true;
        await writeOutboxItem(dir, 'job', 'Job', 'arrived during delivery', t0 + 5000);
      }
    });
    await deleteOutboxItem(dir, 'job', t0);
    spy.mockRestore();

    expect((await readOutboxItems(dir)).map((item) => item.text)).toEqual([
      'arrived during delivery',
    ]);
    expect(await fs.promises.readdir(dir)).toEqual(['job.json']);
  });

  it('a drain never reads a claim as a pending item', async () => {
    writeClaim(2000);
    expect(await readOutboxItems(dir)).toEqual([]);
  });

  it('leaves a claim made from an item that had been pending for hours', async () => {
    // `rename` keeps the source's mtime, so a claim of an old item looks as
    // stale as the item unless the claim is stamped when it is made. Without
    // that stamp a reclaim pass running mid-delivery hands the claim back to
    // the pending set and the same change reaches its chat twice.
    const t0 = 1_000_000;
    await writeOutboxItem(dir, 'job', 'Job', 'text', t0);
    const aged = new Date(Date.now() - CLAIM_STALE_MS - 60_000);
    fs.utimesSync(path.join(dir, 'job.json'), aged, aged);
    // The reclaim runs at the first moment after the claim exists, which is
    // right where the stamp lands: a pass that saw the item's old mtime would
    // restore the claim out from under the delivery holding it.
    const realUtimes = fs.promises.utimes.bind(fs.promises);
    let reclaimed = -1;
    let claimSurvived = false;
    let injected = false;
    const spy = vi
      .spyOn(fs.promises, 'utimes')
      .mockImplementation(async (file, atime, mtime) => {
      await realUtimes(file as string, atime, mtime);
      if (injected) return;
      injected = true;
      const names = await fs.promises.readdir(dir);
      claimSurvived = names.some((name) => name.includes('.claim-'));
      reclaimed = await reclaimOutboxClaims(dir);
    });
    await deleteOutboxItem(dir, 'job', t0);
    spy.mockRestore();

    expect(claimSurvived).toBe(true);
    expect(reclaimed).toBe(0);
    // Settled by the delivery that claimed it, not restored under its feet.
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it('reclaims an orphan claim when nothing newer is pending', async () => {
    writeClaim(2000, 'delivered but never settled');
    const touched = await reclaimOutboxClaims(dir, Date.now() + CLAIM_STALE_MS * 2);
    expect(touched).toBe(1);
    expect((await readOutboxItem(dir, 'job'))?.text).toBe('delivered but never settled');
    expect(fs.existsSync(claimFile())).toBe(false);
    // And it is pending again, so the next drain sends it. The text in an
    // orphan claim already reached its chat, so the owner sees it twice:
    // duplicate beats lost, which is the trade the reviewer accepted for the
    // new claim artifact rather than losing a change to a dead window.
    expect((await readOutboxItems(dir)).map((item) => item.text)).toEqual([
      'delivered but never settled',
    ]);
  });

  it('drops an orphan claim when a newer change is already pending', async () => {
    writeClaim(2000, 'older');
    await writeOutboxItem(dir, 'job', 'Job', 'newer', 3000);
    const touched = await reclaimOutboxClaims(dir, Date.now() + CLAIM_STALE_MS * 2);
    expect(touched).toBe(1);
    expect((await readOutboxItem(dir, 'job'))?.text).toBe('newer');
    expect(fs.existsSync(claimFile())).toBe(false);
  });

  it('leaves a claim a live delivery still holds', async () => {
    writeClaim(2000);
    expect(await reclaimOutboxClaims(dir)).toBe(0);
    expect(fs.existsSync(claimFile())).toBe(true);
    expect(await readOutboxItems(dir)).toEqual([]);
  });

  it('discards an item outright for a deleted job, claim or no claim', async () => {
    await writeOutboxItem(dir, 'job', 'Job', 'text', 1000);
    await deleteOutboxItem(dir, 'job');
    expect(await fs.promises.readdir(dir)).toEqual([]);
    await deleteOutboxItem(dir, 'job'); // a second discard is not an error
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
