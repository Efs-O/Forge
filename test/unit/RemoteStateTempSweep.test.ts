import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('remote state temp sweep', () => {
  it('removes old matching temps while keeping fresh and unrelated files', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-temp-'));
    directories.push(directory);
    const state = path.join(directory, 'remote-state-v2.json');
    const oldNames = [
      '.remote-state-v2.json.forge-01234567-89ab-cdef-0123-456789abcdef.tmp',
      'remote-state-v2.json.01234567-89ab-cdef-0123-456789abcdef.tmp',
      'remote-state-v2.json.lock.stale-01234567-89ab-cdef-0123-456789abcdef',
    ];
    for (const name of oldNames) {
      const file = path.join(directory, name);
      await fs.writeFile(file, 'orphan');
      const old = new Date(Date.now() - 11 * 60_000);
      await fs.utimes(file, old, old);
    }
    const fresh = path.join(
      directory,
      '.remote-state-v2.json.forge-fedcba98-7654-3210-fedc-ba9876543210.tmp',
    );
    const unrelated = path.join(directory, 'other-state.json.lock.stale-0123');
    await fs.writeFile(fresh, 'fresh');
    await fs.writeFile(unrelated, 'unrelated');

    await new RemoteRequestStore(state).load();

    for (const name of oldNames)
      await expect(
        fs.stat(path.join(directory, name)).catch(() => undefined),
      ).resolves.toBeUndefined();
    await expect(fs.readFile(fresh, 'utf8')).resolves.toBe('fresh');
    await expect(fs.readFile(unrelated, 'utf8')).resolves.toBe('unrelated');
  });
});
