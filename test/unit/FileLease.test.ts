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
});
