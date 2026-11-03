import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireMediaGpuLease, type MediaGpuLeaseRecord } from '../../src/media/mediaGpuLease';

const pythonFixture = path.resolve('test/fixtures/media/lease.json');
const tempRoots: string[] = [];
async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('media GPU lease protocol', () => {
  it('refuses the lease fixture emitted by the Python implementation when its holder is live', async () => {
    await expect(acquireMediaGpuLease('forge-test', 2, {
      leasePath: pythonFixture, pid: 20, processStartTime: 2000,
      lookupProcessStartTime: async () => 1793260800000,
    })).rejects.toThrow(/held by python-fixture/);
  });

  it('exclusively creates, refuses a live holder, and releases only its own identity', async () => {
    const root = await tempRoot('forge-media-lease-');
    const leasePath = path.join(root, 'lease.json');
    const starts = new Map<number, number>([[10, 1000], [11, 1100]]);
    const lookup = async (pid: number): Promise<number | undefined> => starts.get(pid);
    const holder = await acquireMediaGpuLease('forge-test', 2, {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
      now: () => Date.parse('2026-10-29T12:00:00.000Z'),
    });
    await expect(acquireMediaGpuLease('python-test', 2, {
      leasePath, pid: 11, processStartTime: 1100, lookupProcessStartTime: lookup,
    })).rejects.toThrow(/one lock for every media GPU.*held by forge-test/);

    const replacement: MediaGpuLeaseRecord = {
      ...holder.record, pid: 11, process_start_time: 1100, owner: 'replacement',
    };
    await fs.writeFile(leasePath, `${JSON.stringify(replacement)}\n`);
    await holder.release();
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8'))).toEqual(replacement);
    await fs.rm(root, { recursive: true });
  });

  it('atomically reclaims a stale pid and retries exclusive create once', async () => {
    const root = await tempRoot('forge-media-stale-');
    const leasePath = path.join(root, 'lease.json');
    await fs.copyFile(pythonFixture, leasePath);
    for (let index = 0; index < 6; index++)
      await fs.writeFile(path.join(root, `lease.stale-1000-${index}.json`), '{}');
    const holder = await acquireMediaGpuLease('forge-test', 2, {
      leasePath, pid: 20, processStartTime: 2000,
      lookupProcessStartTime: async () => undefined,
      now: () => Date.parse('2026-10-29T12:00:01.000Z'),
    });
    const names = await fs.readdir(root);
    expect(names.filter((name) => name.startsWith('lease.stale-'))).toHaveLength(5);
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8'))).toEqual(holder.record);
    await holder.release();
    await fs.rm(root, { recursive: true });
  });

  it('treats a recycled pid with a different process start time as stale', async () => {
    const root = await tempRoot('forge-media-recycled-');
    const leasePath = path.join(root, 'lease.json');
    await fs.copyFile(pythonFixture, leasePath);
    const holder = await acquireMediaGpuLease('forge-test', 2, {
      leasePath, pid: 20, processStartTime: 2000,
      lookupProcessStartTime: async () => 999,
      now: () => Date.parse('2026-10-29T12:00:02.000Z'),
    });
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8'))).toEqual(holder.record);
    await holder.release();
    await fs.rm(root, { recursive: true });
  });

  it('refuses malformed lease JSON with the path', async () => {
    const root = await tempRoot('forge-media-malformed-');
    const leasePath = path.join(root, 'lease.json');
    await fs.writeFile(leasePath, '{broken');
    await expect(acquireMediaGpuLease('forge-test', 2, {
      leasePath, pid: 20, processStartTime: 2000,
      lookupProcessStartTime: async () => undefined,
    })).rejects.toThrow(new RegExp(`Malformed media GPU lease JSON.*${leasePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await fs.rm(root, { recursive: true });
  });

  it('never publishes a partial lease when linking the completed temp file fails', async () => {
    const root = await tempRoot('forge-media-partial-');
    const leasePath = path.join(root, 'lease.json');
    await expect(acquireMediaGpuLease('forge-test', 2, {
      leasePath, pid: 20, processStartTime: 2000,
      link: async () => { throw Object.assign(new Error('simulated link failure'), { code: 'EIO' }); },
    })).rejects.toThrow('simulated link failure');
    await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(root)).toEqual([]);
    await fs.rm(root, { recursive: true });
  });

  it('retries a failed release and reclaims its own leaked lease for the same owner', async () => {
    const root = await tempRoot('forge-media-release-');
    const leasePath = path.join(root, 'lease.json');
    const lookup = async (pid: number) => pid === 10 ? 1000 : undefined;
    let rejectOnce = true;
    const leaseDeps = {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
      unlink: async (target: fs.PathLike) => {
        if (String(target) === leasePath && rejectOnce) {
          rejectOnce = false;
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        await fs.unlink(target);
      },
    };
    const first = await acquireMediaGpuLease('same-owner', 2, leaseDeps);
    await expect(first.release()).rejects.toThrow('busy');
    const second = await acquireMediaGpuLease('same-owner', 3, leaseDeps);
    expect(second.record.gpu).toBe(3);
    await second.release();
    await fs.rm(root, { recursive: true });
  });

  it('does not reclaim the same process lease when a different owner asks', async () => {
    const root = await tempRoot('forge-media-owner-');
    const leasePath = path.join(root, 'lease.json');
    const lookup = async () => 1000;
    const first = await acquireMediaGpuLease('first-owner', 2, {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
    });
    await expect(acquireMediaGpuLease('other-owner', 2, {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
    })).rejects.toThrow(/held by first-owner/);
    await first.release();
    await fs.rm(root, { recursive: true });
  });

  it('transfers the lease to a live child pid, and releases the transferred record', async () => {
    const root = await tempRoot('forge-media-transfer-');
    const leasePath = path.join(root, 'lease.json');
    const alive = new Map<number, number>([[10, 1000], [11, 1100]]);
    const lookup = async (pid: number): Promise<number | undefined> => alive.get(pid);
    const window = await acquireMediaGpuLease('sd-server:test', 2, {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
      now: () => Date.parse('2026-10-29T12:20:00.000Z'),
    });
    await window.transfer(11, 1100);
    const transferred: MediaGpuLeaseRecord = {
      pid: 11, process_start_time: 1100, owner: 'sd-server:test', gpu: 2,
      started_at: '2026-10-29T12:20:00.000Z',
    };
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8'))).toEqual(transferred);
    expect(window.record).toEqual(transferred);
    await window.release();
    await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(root, { recursive: true });
  });

  it('refuses a second acquire when the transferred pid is live and the original owner is dead', async () => {
    const root = await tempRoot('forge-media-transfer-stale-');
    const leasePath = path.join(root, 'lease.json');
    const alive = new Map<number, number>([[10, 1000], [11, 1100]]);
    const lookup = async (pid: number): Promise<number | undefined> => alive.get(pid);
    const window = await acquireMediaGpuLease('sd-server:test', 2, {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
    });
    await window.transfer(11, 1100);
    alive.delete(10); // this window is gone; the sd-server it spawned still holds the GPU
    await expect(acquireMediaGpuLease('python-media-taker', 2, {
      leasePath, pid: 12, processStartTime: 1200, lookupProcessStartTime: lookup,
    })).rejects.toThrow(/held by sd-server:test \(pid 11, GPU 2\)/);
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8'))).toMatchObject({
      pid: 11, process_start_time: 1100, owner: 'sd-server:test',
    });
    await window.release();
    await fs.rm(root, { recursive: true });
  });

  it('refuses to transfer a lease another holder already took and leaves the file alone', async () => {
    const root = await tempRoot('forge-media-transfer-lost-');
    const leasePath = path.join(root, 'lease.json');
    const lookup = async (pid: number) => (pid === 10 ? 1000 : 1100);
    const window = await acquireMediaGpuLease('sd-server:test', 2, {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
    });
    const taken: MediaGpuLeaseRecord = {
      pid: 11, process_start_time: 1100, owner: 'python-media-taker', gpu: 2,
      started_at: '2026-10-29T12:30:00.000Z',
    };
    await fs.writeFile(leasePath, `${JSON.stringify(taken)}\n`);
    await expect(window.transfer(12, 1200)).rejects.toThrow(
      /no longer held by sd-server:test \(pid 10\).*left alone/,
    );
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8'))).toEqual(taken);
    expect(window.record).toMatchObject({ pid: 10, process_start_time: 1000 });
    await window.release(); // a mismatch is not this handle's lease: leave it for its owner
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8'))).toEqual(taken);
    await fs.rm(root, { recursive: true });
  });

  it('retries a transfer whose rename a reader holding the lease open rejects', async () => {
    const root = await tempRoot('forge-media-transfer-busy-');
    const leasePath = path.join(root, 'lease.json');
    const lookup = async (pid: number) => (pid === 10 ? 1000 : 1100);
    let attempts = 0;
    const window = await acquireMediaGpuLease('sd-server:test', 2, {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
      rename: async (from, to) => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        await fs.rename(from, to);
      },
    });
    await window.transfer(11, 1100);
    expect(attempts).toBe(2);
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8'))).toMatchObject({ pid: 11 });
    expect(await fs.readdir(root)).toEqual(['lease.json']);
    await window.release();
    await fs.rm(root, { recursive: true });
  });

  it('gives up a transfer after bounded attempts, keeping the old record and leaving no temp file', async () => {
    const root = await tempRoot('forge-media-transfer-stuck-');
    const leasePath = path.join(root, 'lease.json');
    const lookup = async (pid: number) => (pid === 10 ? 1000 : 1100);
    let attempts = 0;
    const window = await acquireMediaGpuLease('sd-server:test', 2, {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
      rename: async () => {
        attempts++;
        throw Object.assign(new Error('readers present'), { code: 'EPERM' });
      },
    });
    await expect(window.transfer(11, 1100)).rejects.toThrow(/after 5 rename attempts/);
    expect(attempts).toBe(5);
    expect(window.record).toMatchObject({ pid: 10, process_start_time: 1000 });
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8'))).toMatchObject({ pid: 10 });
    expect(await fs.readdir(root)).toEqual(['lease.json']);
    await window.release();
    await fs.rm(root, { recursive: true });
  });

  it('retries a release that failed to read a malformed lease instead of doing nothing', async () => {
    const root = await tempRoot('forge-media-release-malformed-');
    const leasePath = path.join(root, 'lease.json');
    const lookup = async (pid: number) => (pid === 10 ? 1000 : undefined);
    const handle = await acquireMediaGpuLease('same-owner', 2, {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
    });
    await fs.writeFile(leasePath, '{broken');
    await expect(handle.release()).rejects.toThrow(/Malformed media GPU lease JSON/);
    await fs.writeFile(leasePath, `${JSON.stringify(handle.record)}\n`);
    await handle.release();
    await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(root, { recursive: true });
  });

  it('refuses to transfer a lease it has already released', async () => {
    const root = await tempRoot('forge-media-transfer-released-');
    const leasePath = path.join(root, 'lease.json');
    const lookup = async (pid: number) => (pid === 10 ? 1000 : 1100);
    const window = await acquireMediaGpuLease('sd-server:test', 2, {
      leasePath, pid: 10, processStartTime: 1000, lookupProcessStartTime: lookup,
    });
    await window.release();
    await expect(window.transfer(11, 1100)).rejects.toThrow(/already released/);
    await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(root, { recursive: true });
  });

  it('restores a fresh lease moved by an interleaved stale claimant and lets only that holder win', async () => {
    const root = await tempRoot('forge-media-race-');
    const leasePath = path.join(root, 'lease.json');
    await fs.copyFile(pythonFixture, leasePath);
    const fresh: MediaGpuLeaseRecord = {
      pid: 30, process_start_time: 3000, owner: 'claimant-a', gpu: 1,
      started_at: '2026-10-29T12:10:00.000Z',
    };
    let interleaved = false;
    await expect(acquireMediaGpuLease('claimant-b', 2, {
      leasePath, pid: 40, processStartTime: 4000,
      lookupProcessStartTime: async () => undefined,
      rename: async (from, to) => {
        if (!interleaved) {
          interleaved = true;
          await fs.rename(from, path.join(root, 'lease.stale-claimant-a.json'));
          await fs.writeFile(from, `${JSON.stringify(fresh)}\n`);
        }
        await fs.rename(from, to);
      },
    })).rejects.toThrow(/claimed during stale-lease recovery/);
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8'))).toEqual(fresh);
    await fs.rm(root, { recursive: true });
  });
});
