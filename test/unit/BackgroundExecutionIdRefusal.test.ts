import { describe, expect, it } from 'vitest';
import { BackgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';

/**
 * One session retried a dead `execution_id` across three calls because the
 * refusal said only `unknown execution id "…"`. `list_executions` is the tool
 * that recovers an id, and `pruneFinished` drops a finished job out of its list
 * after `FINISHED_EXECUTION_TTL_MS`, so both of those belong in the refusal.
 */
describe('an execution id that misses', () => {
  it('names list_executions and says how a finished job leaves its list', async () => {
    const manager = new BackgroundExecutionManager();
    await expect(manager.stop('exec-does-not-exist')).rejects.toThrow(/list_executions/);
    await expect(manager.stop('exec-does-not-exist')).rejects.toThrow(/finished job/);
    await expect(manager.stop('exec-does-not-exist')).rejects.toThrow(
      /another chat or window/,
    );
  });
});
