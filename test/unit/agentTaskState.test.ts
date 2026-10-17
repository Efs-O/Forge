import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../../src/jobs/JobStore';
import { configBackupPath, snapshotConfig } from '../../src/jobs/agentTaskState';

let root: string;
let store: JobStore;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-task-state-'));
  store = new JobStore(path.join(root, 'jobs'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('snapshotConfig (U07-02)', () => {
  it('copies config.yaml to the job backup', async () => {
    const configPath = path.join(root, 'config.yaml');
    await fs.promises.writeFile(configPath, 'models: []\n');
    const backup = await snapshotConfig(store, configPath, 'job');
    expect(backup).toBe(configBackupPath(store, 'job'));
    expect(await fs.promises.readFile(backup!, 'utf8')).toBe('models: []\n');
  });

  it('a missing config has nothing to back up', async () => {
    await expect(snapshotConfig(store, path.join(root, 'absent.yaml'), 'job')).resolves.toBe(
      undefined,
    );
  });

  it('an unreadable config fails the task instead of running without a backup', async () => {
    // A directory reads as EISDIR on every platform, standing in for EACCES.
    await expect(snapshotConfig(store, root, 'job')).rejects.toThrow(
      'Could not read config.yaml to back it up',
    );
  });

  it('a backup that cannot be written fails the task', async () => {
    const configPath = path.join(root, 'config.yaml');
    await fs.promises.writeFile(configPath, 'models: []\n');
    // A file where the state directory belongs makes mkdir fail.
    await fs.promises.mkdir(store.root, { recursive: true });
    await fs.promises.writeFile(path.join(store.root, 'state'), '');
    await expect(snapshotConfig(store, configPath, 'job')).rejects.toThrow(
      'Could not back up config.yaml',
    );
  });
});
