import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usesLocalGpu, isLocalModel } from '../../src/backend/ModelHeuristics';
import { JobsConfigSchema } from '../../src/config/jobsSchema';
import type { GpuGateConfig, ModelConfig } from '../../src/config/types';
import { AgentTaskRunner, type AgentTaskDeps } from '../../src/jobs/agentTask';
import { deferBusyTask } from '../../src/jobs/agentTaskAdmission';
import { gpuGateReason } from '../../src/jobs/gpuIdleGate';
import { JobScheduler } from '../../src/jobs/JobScheduler';
import { defaultState, JobStore } from '../../src/jobs/JobStore';
import { JobSchema, JobStateSchema, type Job } from '../../src/jobs/jobSchema';
import type { IBackendPool } from '../../src/backend/poolTypes';
import type { PowerControl } from '../../src/system/PowerControl';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { GpuInfo } from '../../src/system/systemProbes';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const localModel: ModelConfig = { name: 'local', gguf_path: 'local.gguf' };
const loopbackModel: ModelConfig = {
  name: 'strata',
  provider: 'openai-compatible',
  endpoint: 'http://localhost:8080/v1',
};
const gateConfig: GpuGateConfig = {
  gpus: [0],
  max_util_percent: 1,
  max_idle_vram_mb: 1024,
  sample_seconds: 15,
};

let root: string;
let store: JobStore;

function gpu(overrides: Partial<GpuInfo> = {}): GpuInfo {
  return {
    index: 0,
    name: 'GPU',
    memoryUsedMb: 0,
    memoryTotalMb: 16000,
    utilizationPercent: 0,
    temperatureC: 30,
    ...overrides,
  };
}

function options(overrides: Partial<Parameters<typeof gpuGateReason>[0]> = {}) {
  return {
    jobsRoot: root,
    model: localModel,
    gpuGate: gateConfig,
    loadedModels: () => [],
    now: vi.fn(() => NOW),
    probe: vi.fn(async () => [gpu()]),
    wait: vi.fn(async () => undefined),
    ...overrides,
  };
}

function job(): Job {
  return JobSchema.parse({
    version: 1,
    id: 'gpu-task',
    name: 'GPU task',
    schedule: { kind: 'interval', minutes: 15 },
    check: { kind: 'none' },
    on_change: { kind: 'notify' },
    action: { kind: 'agent_task', task: 'run locally' },
  });
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-gpu-gate-'));
  store = new JobStore(root);
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('usesLocalGpu', () => {
  it('preserves isLocalModel and recognizes only loopback openai-compatible endpoints', () => {
    expect(isLocalModel(localModel)).toBe(true);
    expect(isLocalModel(loopbackModel)).toBe(false);
    expect(usesLocalGpu(localModel)).toBe(true);
    expect(usesLocalGpu(loopbackModel)).toBe(true);
    expect(
      usesLocalGpu({
        name: 'remote',
        provider: 'openai-compatible',
        endpoint: 'https://models.example.test',
      }),
    ).toBe(false);
    expect(
      usesLocalGpu({
        name: 'spoof',
        provider: 'openai-compatible',
        endpoint: 'https://localhost.example.test',
      }),
    ).toBe(false);
    expect(usesLocalGpu({ name: 'cli', provider: 'cli' })).toBe(false);
  });
});

describe('jobs.gpu_gate schema', () => {
  it('requires a non-empty GPU list and defaults the other settings', () => {
    expect(JobsConfigSchema.parse({ gpu_gate: { gpus: [0, 1] } }).gpu_gate).toEqual({
      gpus: [0, 1],
      max_util_percent: 1,
      max_idle_vram_mb: 1024,
      sample_seconds: 15,
    });
    expect(() => JobsConfigSchema.parse({ gpu_gate: { gpus: [] } })).toThrow();
  });
});

describe('gpu.hold', () => {
  it('defers local agent tasks for an empty hold file, even without gpu_gate', async () => {
    await fs.promises.writeFile(path.join(root, 'gpu.hold'), '');
    const result = await gpuGateReason(options({ gpuGate: undefined }), async () => undefined);
    expect(result).toMatch(/^GPU hold \(manual, since /u);
  });

  it('uses the hold reason and mtime', async () => {
    const holdPath = path.join(root, 'gpu.hold');
    await fs.promises.writeFile(holdPath, '{"reason":"training overnight"}');
    const mtime = new Date(NOW - 60_000);
    await fs.promises.utimes(holdPath, mtime, mtime);

    const result = await gpuGateReason(options({ gpuGate: undefined }), async () => undefined);
    expect(result).toBe(`GPU hold (training overnight, since ${mtime.toISOString()})`);
  });

  it('ignores a dead pid and an expired hold without preventing admission', async () => {
    await fs.promises.writeFile(path.join(root, 'gpu.hold'), '{"reason":"old","pid":42}');
    const stale = await gpuGateReason(
      options({ gpuGate: undefined, processExists: () => false }),
      async () => undefined,
    );
    expect(stale).toBeUndefined();

    await fs.promises.writeFile(
      path.join(root, 'gpu.hold'),
      '{"reason":"old","until":"2026-10-01T11:59:59Z"}',
    );
    const expired = await gpuGateReason(options({ gpuGate: undefined }), async () => undefined);
    expect(expired).toBeUndefined();
  });

  it('fails closed on malformed content', async () => {
    await fs.promises.writeFile(path.join(root, 'gpu.hold'), '{broken');
    await expect(gpuGateReason(options(), async () => undefined)).resolves.toMatch(
      /^unreadable GPU hold file: /u,
    );
  });

  it('does not load gpu.hold as a job definition', async () => {
    await store.saveJob(job());
    await fs.promises.writeFile(path.join(root, 'gpu.hold'), '');
    await expect(store.loadAll()).resolves.toHaveLength(1);
    await expect(store.loadAll()).resolves.toMatchObject([{ job: { id: 'gpu-task' } }]);
  });

  it('does not gate cloud, CLI, or watch-only actions, but gates a loopback model', async () => {
    await fs.promises.writeFile(path.join(root, 'gpu.hold'), '');
    const remote = {
      name: 'remote',
      provider: 'openai-compatible',
      endpoint: 'https://models.example.test',
    } satisfies ModelConfig;
    const cli = { name: 'cli', provider: 'cli' } satisfies ModelConfig;
    for (const model of [remote, cli, undefined]) {
      const result = await gpuGateReason(options({ model }), async () => undefined);
      expect(result).toBeUndefined();
    }
    const localEndpoint = await gpuGateReason(
      options({ model: loopbackModel }),
      async () => undefined,
    );
    expect(localEndpoint).toMatch(/^GPU hold/u);
  });

  it('checks the hold before the cheap gates and the probe', async () => {
    await fs.promises.writeFile(path.join(root, 'gpu.hold'), '');
    const cheap = vi.fn(async () => 'slot busy');
    const probe = vi.fn(async () => [gpu()]);
    const result = await gpuGateReason(options({ probe }), cheap);
    expect(result).toMatch(/^GPU hold/u);
    expect(cheap).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('sampled GPU probe', () => {
  it('stops on the first over-limit sample', async () => {
    const probe = vi
      .fn<() => Promise<GpuInfo[]>>()
      .mockResolvedValueOnce([gpu()])
      .mockResolvedValueOnce([gpu()])
      .mockResolvedValueOnce([gpu()])
      .mockResolvedValueOnce([gpu()])
      .mockResolvedValueOnce([gpu({ utilizationPercent: 41 })]);
    const settings = options({ probe });

    const result = await gpuGateReason(settings, async () => undefined);
    expect(result).toBe('GPU 0 at 41% (limit 1%)');
    expect(probe).toHaveBeenCalledTimes(5);
    expect(settings.wait).toHaveBeenCalledTimes(4);
    expect(settings.now).toHaveBeenCalled();
  });

  it('admits after all configured samples remain clear', async () => {
    const probe = vi.fn(async () => [gpu()]);
    const settings = options({ probe });

    await expect(gpuGateReason(settings, async () => undefined)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(15);
    expect(settings.wait).toHaveBeenCalledTimes(14);
  });

  it('checks VRAM only when Forge has no local model loaded', async () => {
    const probe = vi.fn(async () => [gpu({ memoryUsedMb: 14507 })]);
    const settings = options({ probe, gpuGate: { ...gateConfig, sample_seconds: 1 } });
    await expect(gpuGateReason(settings, async () => undefined)).resolves.toBe(
      'GPU 0 has 14507 MiB in use by another process (limit 1024)',
    );

    const loaded = options({
      probe,
      gpuGate: { ...gateConfig, sample_seconds: 1 },
      loadedModels: () => [localModel],
    });
    await expect(gpuGateReason(loaded, async () => undefined)).resolves.toBeUndefined();
  });

  it('fails closed on probe errors and missing GPU rows', async () => {
    await expect(
      gpuGateReason(
        options({ probe: async () => Promise.reject(new Error('nvidia-smi is not on PATH')) }),
        async () => undefined,
      ),
    ).resolves.toBe('nvidia-smi is not on PATH');
    await expect(
      gpuGateReason(options({ probe: async () => [gpu({ index: 1 })] }), async () => undefined),
    ).resolves.toBe('nvidia-smi returned no row for GPU 0');
  });

  it('does not probe when the optional gpu_gate is absent', async () => {
    const probe = vi.fn(async () => [gpu()]);
    const settings = options({ gpuGate: undefined, probe });
    await expect(gpuGateReason(settings, async () => undefined)).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('AgentTaskRunner GPU admission', () => {
  function runnerDeps(
    probe: NonNullable<AgentTaskDeps['gpuGate']>['probe'],
    wait: NonNullable<AgentTaskDeps['gpuGate']>['wait'],
    signal: AbortSignal,
    createConversation: ReturnType<typeof vi.fn>,
  ): AgentTaskDeps {
    const host = {
      status: () => ({
        conversations: [],
        streamingConversationIds: [],
      }),
      createConversation,
      send: vi.fn(),
    };
    const pool = {
      loadedModelsExcept: () => [],
      parallelCapacity: () => 1,
      loadedModelNames: () => [],
      isLoaded: () => false,
    };
    return {
      store,
      power: {
        holdAwake: () => ({ dispose: () => undefined }),
        setScheduledWakes: vi.fn(async () => undefined),
      } as unknown as PowerControl,
      host: () => host as unknown as ForgeHostFacade,
      pool: () => pool as unknown as IBackendPool,
      defaultModel: () => 'local',
      outboxDir: store.outboxDir,
      notifyLocal: vi.fn(),
      busy: () => undefined,
      now: () => NOW,
      gpuGate: {
        config: () => ({ ...gateConfig, sample_seconds: 2 }),
        model: () => localModel,
        loadedModels: () => [],
        signal: () => signal,
        probe,
        wait,
      },
    };
  }

  it('defers on a hold without creating a conversation', async () => {
    await store.saveJob(job());
    await fs.promises.writeFile(path.join(root, 'gpu.hold'), '');
    const createConversation = vi.fn();
    const controller = new AbortController();
    const runner = new AgentTaskRunner(
      runnerDeps(
        async () => [gpu()],
        async () => undefined,
        controller.signal,
        createConversation,
      ),
    );

    await runner.run({ job: job(), state: JobStateSchema.parse({}) }, false);

    const state = (await store.load('gpu-task'))!.state;
    expect(state.task_pending).toBe(true);
    expect(state.task_pending_reason).toMatch(/^GPU hold/u);
    expect(createConversation).not.toHaveBeenCalled();
    expect(await store.readRuns('gpu-task')).toEqual([]);
  });

  it('turns scheduler cancellation into a pending deferral, not a failed run', async () => {
    await store.saveJob(job());
    const controller = new AbortController();
    const probe = vi.fn(async () => [gpu()]);
    const wait = vi.fn(async () => {
      controller.abort();
      throw new Error('scheduler disposed');
    });
    const createConversation = vi.fn();
    const runner = new AgentTaskRunner(
      runnerDeps(probe, wait, controller.signal, createConversation),
    );

    await runner.run({ job: job(), state: JobStateSchema.parse({}) }, false);

    const state = (await store.load('gpu-task'))!.state;
    expect(state.task_pending).toBe(true);
    expect(state.task_pending_reason).toBe('GPU probe aborted');
    expect(probe).toHaveBeenCalledOnce();
    expect(createConversation).not.toHaveBeenCalled();
    expect(await store.readRuns('gpu-task')).toEqual([]);
  });

  it('aborts the active sample when the scheduler is disposed', async () => {
    await store.saveJob(job());
    let notifyWaitStarted: () => void = () => undefined;
    const waitStarted = new Promise<void>((resolve) => {
      notifyWaitStarted = resolve;
    });
    const probe = vi.fn(async () => [gpu()]);
    const wait = vi.fn(
      (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          notifyWaitStarted();
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const createConversation = vi.fn();
    const deps = runnerDeps(probe, wait, new AbortController().signal, createConversation);
    const scheduler = new JobScheduler({
      store,
      power: {
        holdAwake: () => ({ dispose: () => undefined }),
        setScheduledWakes: vi.fn(async () => undefined),
      } as unknown as PowerControl,
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1, gpuGate: gateConfig }),
      workspaceId: 'workspace',
      instanceId: 'scheduler',
      leaseDirectory: root,
      now: () => new Date(NOW),
      agentTask: deps,
    });
    const originalPatchState = store.patchState.bind(store);
    let notifyPending: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      notifyPending = resolve;
    });
    vi.spyOn(store, 'patchState').mockImplementation((id, patch) => {
      originalPatchState(id, patch);
      if (patch.task_pending) notifyPending();
    });

    try {
      await scheduler.start({ immediate: false });
      await scheduler.tick();
      await waitStarted;
      await scheduler.stop();
      await pending;

      expect((await store.load('gpu-task'))!.state.task_pending_reason).toBe('GPU probe aborted');
      expect(createConversation).not.toHaveBeenCalled();
      expect(await store.readRuns('gpu-task')).toEqual([]);
    } finally {
      await scheduler.stop();
    }
  });
});

describe('pending GPU reason and TTL', () => {
  it('writes the latest reason in the one-time TTL skip row', async () => {
    const definition = job();
    await store.saveJob(definition);
    const reason = 'GPU hold (manual, since 2026-10-01T08:00:00.000Z)';
    const state = JobStateSchema.parse({
      ...defaultState(),
      task_pending: true,
      task_pending_since: NOW,
      task_pending_reason: reason,
    });

    await deferBusyTask(
      store,
      { job: definition, state },
      NOW + 16 * 60_000,
      false,
      'GPU 0 at 41% (limit 1%)',
    );

    const runs = await store.readRuns(definition.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.summary).toBe(`skipped: busy (pending 16 min; GPU 0 at 41% (limit 1%))`);
    expect((await store.load(definition.id))!.state.task_pending_reason).toBeNull();
  });
});
