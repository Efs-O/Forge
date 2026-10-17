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
