import * as os from 'os';
import { describe, expect, it, vi } from 'vitest';
import { spawnCliProcess, terminateProcessTree } from '../../src/agents/cliProcess';
import { TEST_BASH } from '../support/bash';

/**
 * #20 — POSIX process-group kill. A CLI agent that forks its own subprocesses
 * used to leave them running: `spawnCliProcess` did not detach, so the child
 * was not a process-group leader, and `terminateProcessTree` signalled only the
 * direct child. Now the child is spawned `detached` (a group leader) and the
 * tree is signalled with `process.kill(-pid)`, reaching every descendant.
 *
 * This is POSIX-only: Windows kills via a taskkill /T job instead, where
 * `detached` is irrelevant, so the test is skipped there.
 */
describe.runIf(process.platform !== 'win32' && Boolean(TEST_BASH))(
  'POSIX process-group kill',
  () => {
    it('kills the whole group, not just the direct child', async () => {
      // bash is spawned detached (a group leader) and starts a long-lived sleep
      // in the same group, then waits for it. Without the group kill, killing
      // bash would orphan the sleep and it would keep running.
      const proc = spawnCliProcess({
        executable: TEST_BASH as string,
        args: ['-c', 'sleep 300 & echo $!; wait'],
        cwd: os.tmpdir(),
      });
      try {
        const sleepPid = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no pid from bash')), 5000);
          proc.stdout?.on('data', (chunk: Buffer) => {
            const m = chunk.toString().match(/\d+/);
            if (m) {
              clearTimeout(timer);
              resolve(Number(m[0]));
            }
          });
        });
        // `$!` is printed after the fork, so the sleep already exists here.
        await terminateProcessTree(proc);
        // Poll until the group is gone and reaped by init.
        await vi.waitFor(() => expect(() => process.kill(sleepPid, 0)).toThrow(), {
          timeout: 5000,
        });
      } finally {
        // Never leak the group, even if the assertions above fail first.
        await terminateProcessTree(proc).catch(() => undefined);
      }
    }, 15000);
  },
);
