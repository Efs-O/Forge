import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const renameRace = vi.hoisted(() => ({
  leasePath: '',
  delayed: false,
  entered: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string) => {
      if (oldPath === renameRace.leasePath && !renameRace.delayed) {
        renameRace.delayed = true;
        renameRace.entered?.();
        await new Promise<void>((resolve) => {
          renameRace.release = resolve;
        });
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

import { FileLease } from '../../src/util/FileLease';

describe('FileLease stale recovery', () => {
  let directory: string | undefined;

  afterEach(async () => {
    renameRace.leasePath = '';
    renameRace.delayed = false;
    renameRace.entered = undefined;
    renameRace.release = undefined;
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('does not move away a fresh lease that won during stale recovery', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-file-lease-'));
    const leasePath = path.join(directory, 'shared.lease.json');
    renameRace.leasePath = leasePath;
    await fs.writeFile(
      leasePath,
      JSON.stringify({
        version: 1,
        key: 'shared',
        token: randomUUID(),
        pid: 1,
        processStartedAt: 0,
        instanceId: 'dead-owner',
        workspaceId: 'workspace',
        heartbeatAt: 0,
      }),
    );

    const firstRenameEntered = new Promise<void>((resolve) => {
      renameRace.entered = resolve;
    });

    const options = (instanceId: string) => ({
      directory: directory as string,
      key: 'shared',
      workspaceId: 'workspace',
      instanceId,
      heartbeatMs: 60_000,
      staleAfterMs: 1,
      onLost: () => {},
    });
    const delayed = FileLease.acquire(options('first'));
    await firstRenameEntered;
    const winner = await FileLease.acquire(options('second'));
    renameRace.release?.();
    const outcomes = await Promise.allSettled([delayed, Promise.resolve(winner)]);

    const acquired = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    expect(acquired).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await acquired[0]?.verify()).toBe(true);
    await acquired[0]?.release();
  });

  it('a lease caught half-written is live until its mtime goes stale (U19-04)', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-file-lease-'));
    const leasePath = path.join(directory, 'shared.lease.json');
    // Another window's `wx` create, seen before its JSON landed.
    await fs.writeFile(leasePath, '{"version":1,"ke');
    const options = {
      directory,
      key: 'shared',
      workspaceId: 'workspace',
      instanceId: 'second',
      heartbeatMs: 60_000,
      staleAfterMs: 20_000,
      onLost: () => {},
    };
    await expect(FileLease.acquire(options)).rejects.toThrow('already owned by another window');
    expect(await fs.readFile(leasePath, 'utf8')).toBe('{"version":1,"ke');

    // The same garbage left by a crash mid-write is reclaimed once stale.
    await fs.utimes(leasePath, new Date(0), new Date(0));
    const lease = await FileLease.acquire(options);
    expect(await lease.verify()).toBe(true);
    await lease.release();
  });
});

describe('FileLease.isHeld', () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  /** A lease record as `acquire` would have written it, at a chosen heartbeat. */
  async function writeLease(
    filePath: string,
    heartbeatAt: number,
    key = 'shared',
  ): Promise<void> {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        key,
        token: randomUUID(),
        pid: 1,
        processStartedAt: 0,
        instanceId: 'serving-window',
        workspaceId: 'workspace',
        heartbeatAt,
      }),
    );
  }

  /**
   * The point of the peek is that a window which is only asking pays one read.
   * A `RemoteTransportManager.startTransport` attempt writes the shared remote
   * state before it tries the lease, so a check that left files, renames or a
   * fresh modified time behind it would cost every other window a re-read of the
   * whole state on every tick — the cost the plan's audit 3.3 refuses heartbeat
   * writes for.
   */
  it('a fresh heartbeat is held, and the read writes nothing', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-lease-held-'));
    const leasePath = path.join(directory, 'shared.lease.json');
    await writeLease(leasePath, Date.now());
    const before = await fs.stat(leasePath);
    const bytesBefore = await fs.readFile(leasePath, 'utf8');
    const listingBefore = await fs.readdir(directory);

    expect(await FileLease.isHeld({ directory, key: 'shared' })).toBe(true);

    const after = await fs.stat(leasePath);
    expect(await fs.readFile(leasePath, 'utf8')).toBe(bytesBefore);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // No `.tmp`, no `.stale-…`: a reader creates nothing, so it cannot leave a
    // window's folder full of the traces of its questions.
    expect(await fs.readdir(directory)).toEqual(listingBefore);
  });

  /** A caller that needs an answer in milliseconds cannot wait 20 s for the
   *  default horizon, so the budget is a parameter — and it is the same default
   *  `acquire` uses, or a peek that said "free" a second before the attempt was
   *  refused would have this window wait for a lease nobody is signing.
   */
  it('a heartbeat that has gone quiet is not held', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-lease-held-'));
    const leasePath = path.join(directory, 'shared.lease.json');
    // 21 s against the shared 20 s default.
    await writeLease(leasePath, Date.now() - 21_000);
    expect(await FileLease.isHeld({ directory, key: 'shared' })).toBe(false);
    expect(await FileLease.isHeld({ directory, key: 'shared', staleAfterMs: 30_000 })).toBe(true);
    // A horizon small enough to test without sleeping: the same file is held or
    // free depending only on how old its sign is.
    await writeLease(leasePath, Date.now() - 10);
    expect(await FileLease.isHeld({ directory, key: 'shared', staleAfterMs: 50 })).toBe(true);
    await writeLease(leasePath, Date.now() - 100);
    expect(await FileLease.isHeld({ directory, key: 'shared', staleAfterMs: 50 })).toBe(false);
  });

  /** `acquire` makes the folder because it is about to write in it; a reader may
   *  not, or every window that is merely asking would leave one behind and every
   *  reader would then have to tell an empty folder from nobody serving.
   */
  it('nobody holding it means false, and the peek does not create the folder', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-lease-held-'));
    const missingDirectory = path.join(directory, 'never-created');
    expect(await FileLease.isHeld({ directory: missingDirectory, key: 'shared' })).toBe(false);
    await expect(fs.stat(missingDirectory)).rejects.toThrow(/ENOENT/);

    const leases = path.join(directory, 'remote-leases');
    await fs.mkdir(leases, { recursive: true });
    expect(await FileLease.isHeld({ directory: leases, key: 'telegram' })).toBe(false);
    expect(await fs.readdir(leases)).toEqual([]);
  });

  /** The defect U19-04 is about, seen from the peek instead of the attempt: a
   *  record that cannot be read is another window's create caught between `wx`
   *  and its write, or garbage from a crash mid-write, and its modified time is
   *  the only sign of life left. Calling it dead would hand the lease to a second
   *  window while the first is still serving the chat.
   */
  it('a half-written lease is held until its modified time goes stale (U19-04)', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-lease-held-'));
    const leasePath = path.join(directory, 'shared.lease.json');
    await fs.writeFile(leasePath, '{"version":1,"ke');
    expect(await FileLease.isHeld({ directory, key: 'shared' })).toBe(true);
    expect(await fs.readFile(leasePath, 'utf8')).toBe('{"version":1,"ke');
    await fs.utimes(leasePath, new Date(0), new Date(0));
    expect(await FileLease.isHeld({ directory, key: 'shared' })).toBe(false);
  });

  /** Characters a filesystem cannot take in a name are replaced, and the peek
   *  must look at the file `acquire` would have written, not at a name of its
   *  own: a peek that missed the file would say "free" and let a window write the
   *  shared state for nothing, which is the whole cost this check exists to pay.
   */
  it('a key with a colon in it is the same file acquire would use', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-lease-held-'));
    await writeLease(path.join(directory, 'jobs_scheduler.lease.json'), Date.now(), 'jobs:scheduler');
    expect(await FileLease.isHeld({ directory, key: 'jobs:scheduler' })).toBe(true);
    expect(await FileLease.isHeld({ directory, key: 'jobs_scheduler' })).toBe(true);
    expect(await FileLease.isHeld({ directory, key: 'jobs' })).toBe(false);
  });

  /** The risk of adding a second path to one decision: a peek that disagrees with
   *  the attempt is worse than no peek, because a window that believed the lease
   *  was free would write shared state and then be refused anyway. So the two are
   *  asserted against each other, at each end of the horizon and with no file.
   */
  it('the peek and the attempt never disagree', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-lease-held-'));
    const leasePath = path.join(directory, 'shared.lease.json');
    const options = {
      directory,
      key: 'shared',
      workspaceId: 'workspace',
      heartbeatMs: 60_000,
      onLost: () => undefined,
    };

    await writeLease(leasePath, Date.now());
    expect(await FileLease.isHeld(options)).toBe(true);
    await expect(FileLease.acquire({ ...options, instanceId: 'second' })).rejects.toThrow(
      'already owned by another window',
    );

    await writeLease(leasePath, Date.now() - 21_000);
    expect(await FileLease.isHeld(options)).toBe(false);
    const reclaimed = await FileLease.acquire({ ...options, instanceId: 'third' });
    expect(await reclaimed.verify()).toBe(true);
    await reclaimed.release();

    expect(await FileLease.isHeld(options)).toBe(false);
    const fresh = await FileLease.acquire({ ...options, instanceId: 'fourth' });
    expect(await FileLease.isHeld(options)).toBe(true);
    await fresh.release();
  });
});
