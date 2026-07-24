import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { ForgeConfig } from '../../src/config/types';
import { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { ToolDispatch } from '../../src/sidebar/ToolDispatch';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { WorkerOrchestrationService } from '../../src/workers/WorkerOrchestrationService';

function config(models: ForgeConfig['models']): ForgeConfig {
  return {
    models,
    active_model: models[0]?.name,
    llama_server: {},
    permissions: {
      fs: { read: true, write: true },
      agents: { delegate: true, cloud_workers: false },
    },
  };
}

describe('WorkerOrchestrationService validation', () => {
  let root: string;
  const pool = {
    acquireGroupForDelegation: vi.fn(() => Promise.reject(new Error('must not acquire'))),
    parallelCapacity: vi.fn(() => 1),
  } as unknown as IBackendPool;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-worker-service-'));
    fs.mkdirSync(path.join(root, 'src'));
    vi.clearAllMocks();
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function service(forgeConfig: ForgeConfig): WorkerOrchestrationService {
    return new WorkerOrchestrationService({
      getConfig: () => forgeConfig,
      pool,
      registry: new ToolRegistry(),
      workspaceRoot: root,
    });
  }

  function context() {
    const checkpoints = new CheckpointStack();
    return {
      checkpoint: checkpoints.beginTurn('test'),
      conversationId: 'conv',
      abortSignal: new AbortController().signal,
      toolDispatch: {} as ToolDispatch,
      coordinatorModel: 'local',
    };
  }

  it('rejects duplicate exact write ownership before backend admission', async () => {
    const run = service(config([{ name: 'local', provider: 'llama.cpp' }])).run(
      {
        workers: [
          {
            id: 'one',
            model: 'local',
            task: 'one',
            access: 'write',
            allowed_paths: ['src/shared.ts'],
          },
          {
            id: 'two',
            model: 'local',
            task: 'two',
            access: 'write',
            allowed_paths: ['src/shared.ts'],
          },
        ],
      },
      context(),
    );
    await expect(run).rejects.toThrow('Worker write conflict');
    expect(pool.acquireGroupForDelegation).not.toHaveBeenCalled();
  });

  it('enforces direct-command bounds that cannot rely on JSON Schema', async () => {
    const run = service(config([{ name: 'local', provider: 'llama.cpp' }])).run(
      {
        workers: [
          {
            id: 'one',
            model: 'local',
            task: 'task',
            access: 'write',
            allowed_paths: ['src/a.ts'],
            max_output_tokens: 50_000,
          },
        ],
      },
      context(),
    );
    await expect(run).rejects.toThrow('invalid max_output_tokens');
  });

  it('rejects absolute context hints at the runtime boundary', async () => {
    const run = service(config([{ name: 'local', provider: 'llama.cpp' }])).run(
      {
        workers: [
          {
            id: 'one',
            model: 'local',
            task: 'review',
            access: 'read',
            context_files: [path.join(root, 'src', 'a.ts')],
          },
        ],
      },
      context(),
    );
    await expect(run).rejects.toThrow('Absolute paths are not allowed');
    expect(pool.acquireGroupForDelegation).not.toHaveBeenCalled();
  });

  it('blocks cloud targets unless cloud_workers is explicitly enabled', async () => {
    const run = service(config([{ name: 'cloud', provider: 'openai' }])).run(
      {
        workers: [
          {
            id: 'one',
            model: 'cloud',
            task: 'task',
            access: 'write',
            allowed_paths: ['src/a.ts'],
          },
        ],
      },
      context(),
    );
    await expect(run).rejects.toThrow('permissions.agents.cloud_workers: true');
    expect(pool.acquireGroupForDelegation).not.toHaveBeenCalled();
  });

  it('accepts an all-read request without write permission and rejects writable paths', async () => {
    const forgeConfig = config([{ name: 'local', provider: 'llama.cpp' }]);
    forgeConfig.permissions = {
      fs: { read: true, write: false },
      agents: { delegate: true, cloud_workers: false },
    };
    const invalid = service(forgeConfig).run(
      {
        workers: [
          {
            id: 'reader',
            model: 'local',
            task: 'review',
            access: 'read',
            allowed_paths: ['src/a.ts'],
          },
        ],
      },
      context(),
    );
    await expect(invalid).rejects.toThrow('must not include allowed_paths');
    expect(pool.acquireGroupForDelegation).not.toHaveBeenCalled();

    const valid = service(forgeConfig).run(
      {
        workers: [{ id: 'reader', model: 'local', task: 'review', access: 'read' }],
      },
      context(),
    );
    await expect(valid).rejects.toThrow('must not acquire');
    expect(pool.acquireGroupForDelegation).toHaveBeenCalledOnce();
  });

  it('routes provider:cli workers around the backend pool entirely', async () => {
    const forgeConfig = config([
      {
        name: 'claude-code',
        provider: 'cli',
        cli: 'forge-test-cli-that-does-not-exist',
      },
    ]);
    const result = await service(forgeConfig).run(
      {
        workers: [{ id: 'agent', model: 'claude-code', task: 'review the auth module', access: 'read' }],
      },
      context(),
    );
    // A deliberately nonexistent CLI resolves to failed_startup rather than
    // asking the backend pool for a local llama.cpp/Ollama slot.
    expect(pool.acquireGroupForDelegation).not.toHaveBeenCalled();
    expect(result.workers[0]?.status).toBe('failed_startup');
    expect(result.workers[0]?.error).toContain('install it and log in');
  });
});
