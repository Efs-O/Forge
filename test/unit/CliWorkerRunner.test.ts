import { describe, expect, it, vi } from 'vitest';
import type { CheckpointSession } from '../../src/checkpoint/CheckpointStack';
import { runCliWorker } from '../../src/agents/CliWorkerRunner';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';
import type { WorkerSpec } from '../../src/workers/types';

function fakeDriver(run: CliAgentDriver['run']): CliAgentDriver {
  return { run } as unknown as CliAgentDriver;
}

function fakeCheckpoint(): { checkpoint: CheckpointSession; snapshotBefore: ReturnType<typeof vi.fn> } {
  const snapshotBefore = vi.fn();
  return { checkpoint: { snapshotBefore } as unknown as CheckpointSession, snapshotBefore };
}

const readSpec: WorkerSpec = {
  id: 'w1',
  model: 'claude-code',
  task: 'review the auth module',
  access: 'read',
};

const writeSpec: WorkerSpec = {
  id: 'w1',
  model: 'claude-code',
  task: 'fix the bug',
  access: 'write',
  allowed_paths: ['src/foo.ts'],
};

describe('runCliWorker', () => {
  it('resolves the executable, snapshots writable paths BEFORE spawning, then runs the driver', async () => {
    const order: string[] = [];
    const { checkpoint, snapshotBefore } = fakeCheckpoint();
    snapshotBefore.mockImplementation(() => order.push('snapshot'));
    const run = vi.fn(async () => {
      order.push('spawn');
      return { status: 'completed' as const, finalText: 'Done: updated src/foo.ts' };
    });

    const result = await runCliWorker({
      spec: writeSpec,
      cliName: 'claude',
      cliExecutable: process.execPath,
      workspaceRoot: 'C:\\workspace',
      writablePaths: ['C:\\workspace\\src\\foo.ts'],
      checkpoint,
      abortSignal: new AbortController().signal,
      driver: fakeDriver(run),
    });

    expect(order).toEqual(['snapshot', 'spawn']);
    expect(snapshotBefore).toHaveBeenCalledWith('C:\\workspace\\src\\foo.ts');
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Done: updated src/foo.ts');
    expect(result.changedPaths).toEqual([]);
  });

  it('never snapshots for read-access workers', async () => {
    const { checkpoint, snapshotBefore } = fakeCheckpoint();
    const run = vi.fn(async () => ({ status: 'completed' as const, finalText: 'analysis' }));

    await runCliWorker({
      spec: readSpec,
      cliName: 'claude',
      cliExecutable: process.execPath,
      workspaceRoot: 'C:\\workspace',
      writablePaths: [],
      checkpoint,
      abortSignal: new AbortController().signal,
      driver: fakeDriver(run),
    });

    expect(snapshotBefore).not.toHaveBeenCalled();
  });

  it('maps driver statuses onto WorkerStatus', async () => {
    const { checkpoint } = fakeCheckpoint();
    for (const [driverStatus, expected] of [
      ['completed', 'completed'],
      ['cancelled', 'cancelled'],
      ['timed_out', 'timed_out'],
      ['failed', 'failed_model'],
    ] as const) {
      const run = vi.fn(async () => ({ status: driverStatus, finalText: '', error: 'x' }));
      const result = await runCliWorker({
        spec: readSpec,
        cliName: 'claude',
        cliExecutable: process.execPath,
        workspaceRoot: 'C:\\workspace',
        writablePaths: [],
        checkpoint,
        abortSignal: new AbortController().signal,
        driver: fakeDriver(run),
      });
      expect(result.status).toBe(expected);
    }
  });

  it('returns failed_startup with a clear message when the executable cannot be resolved, and never spawns', async () => {
    const { checkpoint, snapshotBefore } = fakeCheckpoint();
    const run = vi.fn();

    const result = await runCliWorker({
      spec: writeSpec,
      cliName: 'claude',
      cliExecutable: '/definitely/not/on/path/claude-nonexistent',
      workspaceRoot: 'C:\\workspace',
      writablePaths: ['C:\\workspace\\src\\foo.ts'],
      checkpoint,
      abortSignal: new AbortController().signal,
      driver: fakeDriver(run),
    });

    expect(result.status).toBe('failed_startup');
    expect(result.error).toContain('install it and log in');
    expect(run).not.toHaveBeenCalled();
    expect(snapshotBefore).not.toHaveBeenCalled();
  });
});
