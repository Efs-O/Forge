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
});
