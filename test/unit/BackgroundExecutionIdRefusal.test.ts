import { describe, expect, it } from 'vitest';
import { BackgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';

/**
 * One session retried a dead `execution_id` across three calls because the
 * refusal said only `unknown execution id "…"`. `list_executions` is the tool
 * that recovers an id, and `pruneFinished` drops a finished job out of its list
 * after `FINISHED_EXECUTION_TTL_MS`, so both of those belong in the refusal.
 */
describe('an execution id that misses', () => {
  it('states the TTL, capacity eviction and window scope without promising retention', async () => {
    const manager = new BackgroundExecutionManager();
    await expect(manager.stop('exec-does-not-exist')).rejects.toThrow(
      'unknown execution id "exec-does-not-exist". Call `list_executions` for the jobs retained in this window, including jobs from its other chats. A finished job is retained for up to 10 minutes; it may be evicted earlier when the 32-job limit is reached. Reloading the window clears this in-memory list. Jobs from another window are not listed here.',
    );
  });

  it('runs the call whose id was cut short, and answers with the full id', async () => {
    // Session a028c492-0817-424c-86bc-344da8a8b75a: row 14310 handed back
    // `exec-92bfe375-c54a-4a6f-aa4b-21fee8c28be3`, row 14383 sent the
    // `exec-92bfe375` the model had written in its own notes, and the call died.
    const manager = new BackgroundExecutionManager();
    try {
      const started = manager.start({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
      });
      const short = started.id.slice(0, 'exec-xxxxxxxx'.length);
      expect(short).not.toBe(started.id);

      const observation = await manager.stop(short);

      expect(observation.id).toBe(started.id);
    } finally {
      await manager.dispose();
    }
  });

  it('still accepts an id that matches in full', async () => {
    const manager = new BackgroundExecutionManager();
    try {
      const started = manager.start({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
      });

      expect((await manager.stop(started.id)).id).toBe(started.id);
    } finally {
      await manager.dispose();
    }
  });

  it('refuses a prefix that could mean two retained jobs, and names them', async () => {
    const manager = new BackgroundExecutionManager();
    const executions = (manager as unknown as { executions: Map<string, never> }).executions;
    // No child process is started here, so there is nothing for dispose() to
    // reap: the two entries exist only to make a prefix ambiguous.
    executions.set('exec-aaaa1111-0000-0000-000000000000', undefined as never);
    executions.set('exec-aaaa2222-0000-0000-000000000000', undefined as never);

    await expect(manager.stop('exec-aaaa')).rejects.toThrow(
      'execution id "exec-aaaa" is a prefix of 2 retained jobs (exec-aaaa1111-0000-0000-000000000000, ' +
        'exec-aaaa2222-0000-0000-000000000000). Pass the full id from `list_executions`.',
    );
  });
});
