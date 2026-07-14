import { describe, expect, it } from 'vitest';
import {
  addWorkerDelegationInstructions,
  buildWorkerReviewPrompt,
} from '../../src/workers/WorkerPrompts';

describe('worker coordinator prompts', () => {
  it('teaches an enabled coordinator to discover and dispatch models', () => {
    const messages = addWorkerDelegationInstructions(
      [
        { role: 'system', content: 'base' },
        { role: 'user', content: 'task' },
      ],
      true,
    );
    expect(messages[0]?.content).toContain('call list_worker_models');
    expect(messages[0]?.content).toContain('call dispatch_workers');
    expect(messages[1]).toEqual({ role: 'user', content: 'task' });
  });

  it('limits review to verified changed paths', () => {
    const prompt = buildWorkerReviewPrompt({
      runId: 'run',
      status: 'completed',
      executionMode: 'parallel',
      workers: [
        {
          id: 'one',
          model: 'local',
          status: 'completed',
          summary: 'done',
          changedPaths: ['src/a.ts'],
        },
      ],
    });
    expect(prompt).toContain('Verified worker-changed paths:\n- src/a.ts');
    expect(prompt).toContain('unrelated pre-existing worktree changes');
  });

  it('avoids repository-wide diffing when workers changed nothing', () => {
    const prompt = buildWorkerReviewPrompt({
      runId: 'run',
      status: 'completed',
      executionMode: 'best-effort',
      workers: [
        {
          id: 'one',
          model: 'local',
          status: 'completed_no_changes',
          summary: 'reviewed',
          changedPaths: [],
        },
      ],
    });
    expect(prompt).toContain('no verified file changes');
    expect(prompt).toContain('Do not run repository-wide git status or diff');
  });
});
