import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { WorkerLoop, type WorkerExecutionTarget } from '../../src/workers/WorkerLoop';
import type { WorkerAccessPolicy } from '../../src/workers/WorkerAccessPolicy';
import type { WorkerRunContext, WorkerSpec } from '../../src/workers/types';

const { runCliWorker } = vi.hoisted(() => ({ runCliWorker: vi.fn() }));
const { runToolCallingLoop } = vi.hoisted(() => ({ runToolCallingLoop: vi.fn() }));

vi.mock('../../src/agents/CliWorkerRunner', () => ({ runCliWorker }));
vi.mock('../../src/agent/ToolCallingLoop', () => ({ runToolCallingLoop }));

const spec: WorkerSpec = {
  id: 'worker',
  model: 'claude-code',
  task: 'fix the bug',
  access: 'write',
  allowed_paths: ['src/foo.ts'],
};

const cliTarget: WorkerExecutionTarget = {
  model: { name: 'claude-code', provider: 'cli', cli: 'claude' },
  kind: 'cli',
  bestEffort: false,
};

const policy = {
  scope: () => undefined,
  changedPaths: () => [],
  writablePaths: () => ['C:\\workspace\\src\\foo.ts'],
} as unknown as WorkerAccessPolicy;

function context(): WorkerRunContext {
  return {
    checkpoint: { snapshotBefore: vi.fn() } as never,
    conversationId: 'conversation',
    abortSignal: new AbortController().signal,
    toolDispatch: {} as ToolDispatch,
  };
}

function loop(exec?: ForgeConfig['exec']): WorkerLoop {
  const config = {
    models: [{ name: 'claude-code', provider: 'cli' as const, cli: 'claude' }],
    llama_server: {},
    permissions: { fs: { read: true, write: true }, agents: { delegate: true } },
    ...(exec ? { exec } : {}),
  } as ForgeConfig;
  return new WorkerLoop(() => config, new ToolRegistry(), 'C:\\workspace');
}

describe('WorkerLoop cli routing', () => {
  it('routes provider:cli targets to runCliWorker and never touches the LLM tool-calling loop', async () => {
    runCliWorker.mockResolvedValue({
      id: 'worker',
      model: 'claude-code',
      status: 'completed',
      summary: 'Done: updated src/foo.ts',
      changedPaths: [],
    });
    const result = await loop().run(spec, cliTarget, policy, context());
    expect(runCliWorker).toHaveBeenCalledTimes(1);
    expect(runToolCallingLoop).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    const call = runCliWorker.mock.calls[0][0];
    expect(call.cliName).toBe('claude');
    expect(call.cliExecutable).toBe('claude');
    expect(call.writablePaths).toEqual(['C:\\workspace\\src\\foo.ts']);
  });

  it('threads config exec.timeout_ms into the cli run when set', async () => {
    runCliWorker.mockResolvedValue({
      id: 'worker',
      model: 'claude-code',
      status: 'completed',
      summary: '',
      changedPaths: [],
    });
    await loop({ timeout_ms: 42_000 }).run(spec, cliTarget, policy, context());
    const call = runCliWorker.mock.calls.at(-1)?.[0];
    expect(call.timeoutMs).toBe(42_000);
  });

  it('forwards the onProgress callback through to runCliWorker', async () => {
    runCliWorker.mockResolvedValue({
      id: 'worker',
      model: 'claude-code',
      status: 'completed',
      summary: '',
      changedPaths: [],
    });
    const onProgress = vi.fn();
    await loop().run(spec, cliTarget, policy, context(), onProgress);
    const call = runCliWorker.mock.calls.at(-1)?.[0];
    expect(call.onProgress).toBe(onProgress);
  });
});
