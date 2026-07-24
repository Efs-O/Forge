import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import type { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { ToolLoopDetectedError } from '../../src/agent/ToolLoopGuard';
import { buildWorkerSystemPrompt, WorkerLoop } from '../../src/workers/WorkerLoop';
import type { WorkerAccessPolicy } from '../../src/workers/WorkerAccessPolicy';
import type { WorkerRunContext, WorkerSpec } from '../../src/workers/types';

const { runToolCallingLoop } = vi.hoisted(() => ({ runToolCallingLoop: vi.fn() }));

vi.mock('../../src/agent/ToolCallingLoop', () => ({ runToolCallingLoop }));

const spec: WorkerSpec = {
  id: 'worker',
  model: 'local',
  task: 'test',
  access: 'read',
};

function harness(): WorkerLoop {
  const config = {
    models: [{ name: 'local', provider: 'llama.cpp' }],
    llama_server: {},
    permissions: { fs: { read: true }, agents: { delegate: true } },
  } as ForgeConfig;
  return new WorkerLoop(() => config, new ToolRegistry(), 'C:\\workspace');
}

const policy = {
  scope: () => undefined,
  changedPaths: () => [],
} as unknown as WorkerAccessPolicy;

const context = {
  checkpoint: {},
  conversationId: 'conversation',
  abortSignal: new AbortController().signal,
  toolDispatch: {} as ToolDispatch,
} as WorkerRunContext;

const target = {
  model: { name: 'local', provider: 'llama.cpp' as const },
  baseUrl: 'http://127.0.0.1:8080',
  bestEffort: false,
};

describe('WorkerLoop', () => {
  it('includes truthful platform and argv context in its system prompt', () => {
    const prompt = buildWorkerSystemPrompt(spec, 'C:\\workspace');
    expect(prompt).toContain(`platform=${process.platform}`);
    expect(prompt).toContain(`arch=${process.arch}`);
    expect(prompt).toContain('command_contract=executable-plus-argv');
    expect(prompt).toContain('no shell operators');
    expect(prompt).toContain('C:\\workspace');
  });

  it('classifies empty length termination as token exhaustion', async () => {
    runToolCallingLoop.mockResolvedValue({
      finishReason: 'length',
      finalText: '',
      rounds: 1,
      repeatedCall: false,
    });
    await expect(harness().run(spec, target, policy, context)).resolves.toMatchObject({
      status: 'exhausted_tokens',
    });
  });

  it('classifies round exhaustion separately from model failure', async () => {
    runToolCallingLoop.mockRejectedValue(
      new Error('Forge: agent exceeded maximum tool rounds (8).'),
    );
    await expect(harness().run(spec, target, policy, context)).resolves.toMatchObject({
      status: 'exhausted_steps',
    });
  });

  it('classifies detected tool cycles as failed loops', async () => {
    runToolCallingLoop.mockRejectedValue(new ToolLoopDetectedError('loop'));
    await expect(harness().run(spec, target, policy, context)).resolves.toMatchObject({
      status: 'failed_loop',
    });
  });

  it('honors the resolved worker model tools allowlist when building tool definitions', async () => {
    runToolCallingLoop.mockResolvedValue({
      finishReason: 'stop',
      finalText: 'done',
      rounds: 1,
      repeatedCall: false,
    });
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        type: 'function',
        function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
      },
      permission: 'read',
      handler: vi.fn().mockResolvedValue('ok'),
    });
    registry.register({
      definition: {
        type: 'function',
        function: { name: 'run_terminal', description: 'exec', parameters: { type: 'object' } },
      },
      permission: 'terminal',
      handler: vi.fn().mockResolvedValue('ok'),
    });
    const config = {
      models: [{ name: 'local', provider: 'llama.cpp' }],
      llama_server: {},
      permissions: {
        fs: { read: true },
        exec: { terminal: true },
        agents: { delegate: true },
      },
    } as ForgeConfig;
    const loop = new WorkerLoop(() => config, registry, 'C:\\workspace');
    const scopedTarget = {
      model: { name: 'local', provider: 'llama.cpp' as const, tools: ['read_file'] },
      baseUrl: 'http://127.0.0.1:8080',
      bestEffort: false,
    };

    await loop.run(spec, scopedTarget, policy, context);

    const lastCall = runToolCallingLoop.mock.calls.at(-1);
    const options = lastCall?.[0] as { toolDefinitions: { function: { name: string } }[] };
    expect(options.toolDefinitions.map((d) => d.function.name)).toEqual(['read_file']);
  });
});
