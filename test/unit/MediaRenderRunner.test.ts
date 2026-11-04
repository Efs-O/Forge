/**
 * The ledger row CI-enforces (docs/plans/MEDIA_SHIPPED_PLAN.md, "State x
 * lifecycle ledger": "the lease is released on every exit path"): a fake
 * background process that (a) exits 0, (b) exits non-zero, (c) throws before
 * the spawn, and (d) is aborted must each leave no lease file. Added here: the
 * child-error path, the idle-wait timeout, the lease transfer to the child pid,
 * and a two-stage run whose lease is released once, after the LAST stage.
 *
 * The lease is the real protocol in a temp folder; only the process is faked,
 * so no ComfyUI, GPU job or network call runs.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireMediaGpuLease, type MediaGpuLeaseRecord } from '../../src/media/mediaGpuLease';
import type {
  BackgroundExecutionManager,
  BackgroundExecutionStartOptions,
  BackgroundExecutionStatus,
} from '../../src/tools/BackgroundExecutionManager';
import { mediaOutcomeNotice } from '../../src/tools/media/mediaManifest';
import {
  startMediaRender,
  type MediaRenderDeps,
  type MediaRenderRequest,
} from '../../src/tools/media/mediaRenderRunner';

void (null as unknown as BackgroundExecutionManager);

let root: string;
let leasePath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-media-runner-'));
  leasePath = path.join(root, 'media-gpu', 'lease.json');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function leaseExists(): Promise<boolean> {
  try {
    await fs.access(leasePath);
    return true;
  } catch {
    return false;
  }
}

/** Wait for the detached chain to hand the lease back. Generous: the whole
 * suite runs this file under load, and the release is a promise chain, not a
 * timer, so only the machine's scheduling can make it slow. */
async function leaseReleased(): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await leaseExists())) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

/** Wait until the chain has started this many stages. */
async function startedStages(manager: FakeManager, count: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (manager.starts.length >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

interface FakeManager {
  /** Every option set the runner handed `background.start`, notice fields included. */
  starts: BackgroundExecutionStartOptions[];
  waitFinished: (id: string, signal?: AbortSignal) => Promise<unknown>;
  resolve: (completion?: unknown) => void;
}

function fakeManager(delayed = true): FakeManager {
  const manager: FakeManager = {
    starts: [],
    resolve: () => undefined,
    waitFinished: () => Promise.resolve({ status: 'completed', exitCode: 0 }),
  };
  const gates: ((completion: unknown) => void)[] = [];
  const earlyCompletions: unknown[] = [];
  manager.waitFinished = (id, signal) => {
    void id;
    void signal;
    if (earlyCompletions.length) return Promise.resolve(earlyCompletions.shift());
    const gate = new Promise<unknown>((resolve) => {
      gates.push((completion) => resolve(completion));
    });
    return delayed ? gate : Promise.resolve(undefined);
  };
  manager.resolve = (completion) => {
    const result = completion ?? { status: 'completed', exitCode: 0 };
    const gate = gates.shift();
    if (gate) gate(result);
    else earlyCompletions.push(result);
  };
  // The runner's own options are what the notice tests read: a non-final stage
  // must carry neither `notifyConversationId` nor `exitSummary`, so the analysis
  // stage of a two-stage run cannot wake the chat before anything rendered.
  const view = {
    start: (spec: BackgroundExecutionStartOptions) => {
      manager.starts.push(spec);
      return {
        id: `exec-${manager.starts.length}`,
        status: 'running' as BackgroundExecutionStatus,
        pid: 4240 + manager.starts.length,
        startedAt: Date.now(),
      };
    },
    waitFinished: (id: string, signal?: AbortSignal) => manager.waitFinished(id, signal),
  };
  (manager as { view?: unknown }).view = view;
  return manager;
}

function request(overrides: Partial<MediaRenderRequest> = {}): MediaRenderRequest {
  return {
    runId: 'm-run-1',
    runDir: root,
    kind: 'video',
    engineId: 'ltx25',
    cudaDevices: [2],
    command: 'python',
    args: ['media_job.py', 'job.json'],
    cwd: root,
    jobFile: path.join(root, 'job.json'),
    env: { CUDA_VISIBLE_DEVICES: '2' },
    timeoutMs: 60_000,
    conversationId: 'conversation-1',
    ...overrides,
  };
}

function depsFor(manager: FakeManager, overrides: Partial<MediaRenderDeps> = {}): MediaRenderDeps {
  return {
    lifecycle: {
      loadedModels: () => [{ name: 'strata', gpus: [0, 1] }],
      isBusy: () => false,
      unloadModel: async () => ({ unloaded: true }),
    },
    leasePath,
    leasePid: 10,
    leaseProcessStartTime: 1000,
    lookupProcessStartTime: async (pid) => (pid === 10 ? 1000 : 2000),
    background: (manager as { view?: unknown }).view as MediaRenderDeps['background'],
    log: () => {},
    ...overrides,
  };
}

async function readLease(): Promise<MediaGpuLeaseRecord> {
  return JSON.parse(await fs.readFile(leasePath, 'utf8')) as MediaGpuLeaseRecord;
}

describe('startMediaRender: the lease is released on every exit path', () => {
  it('releases the lease when the child exits 0, and names the child while it runs', async () => {
    const manager = fakeManager();
    const started = await startMediaRender(request(), depsFor(manager));
    expect(started.executionId).toBe('exec-1');
    // The lease is still held while the render is, and it names the child pid
    // rather than this window, so a force-killed host cannot orphan the GPU.
    expect(await leaseExists()).toBe(true);
    expect((await readLease()).pid).toBe(4241);
    manager.resolve();
    expect(await leaseReleased()).toBe(true);
  });

  it('releases the lease when the child exits non-zero', async () => {
    const manager = fakeManager();
    manager.waitFinished = () => Promise.resolve({ status: 'failed', exitCode: 3 });
    await startMediaRender(request(), depsFor(manager));
    manager.resolve();
    expect(await leaseReleased()).toBe(true);
  });

  it('releases the lease when the spawn itself throws, and reports the failure', async () => {
    const manager = fakeManager(false);
    const deps = depsFor(manager);
    const throwing = {
      ...deps,
      background: {
        start: () => {
          throw new Error('background execution limit reached');
        },
        waitFinished: () => Promise.resolve(undefined),
      },
    };
    await expect(startMediaRender(request(), throwing)).rejects.toThrow(
      /background execution limit reached/,
    );
    expect(await leaseExists()).toBe(false);
  });

  it('releases the lease when the turn is aborted before the spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = depsFor(fakeManager(false), {
      lifecycle: {
        loadedModels: () => [{ name: 'worker', gpus: [2] }],
        isBusy: () => true,
        unloadModel: async () => ({ unloaded: true }),
      },
      wait: () => Promise.resolve(),
      idleWaitMs: 10,
      idlePollMs: 5,
    });
    await expect(
      startMediaRender({ ...request(), abortSignal: controller.signal }, deps),
    ).rejects.toThrow(/aborted/);
    expect(await leaseExists()).toBe(false);
  });

  it('releases the lease when the child never started (its error path)', async () => {
    const manager = fakeManager();
    manager.waitFinished = () => Promise.resolve({ status: 'failed', error: 'spawn ENOENT' });
    await startMediaRender(request(), depsFor(manager));
    manager.resolve();
    expect(await leaseReleased()).toBe(true);
  });

  it('releases the lease when a busy model is never freed, and never unloads it', async () => {
    const unloaded: string[] = [];
    const deps = depsFor(fakeManager(false), {
      lifecycle: {
        loadedModels: () => [{ name: 'worker', gpus: [2] }],
        isBusy: () => true,
        unloadModel: async (model) => {
          unloaded.push(model);
          return { unloaded: true };
        },
      },
      wait: () => Promise.resolve(),
      idleWaitMs: 20,
      idlePollMs: 5,
    });
    await expect(startMediaRender(request(), deps)).rejects.toThrow(/"worker" is still generating/);
    expect(unloaded).toEqual([]);
    expect(await leaseExists()).toBe(false);
  });

  it('holds one lease across a two-stage run and releases it after the last stage', async () => {
    const manager = fakeManager();
    const logs: string[] = [];
    const second = request({ engineId: 'ace_step' });
    const started = await startMediaRender(
      { ...request(), next: () => Promise.resolve(second) },
      depsFor(manager, { log: (line) => logs.push(line) }),
    );
    manager.resolve();
    // Stage 2 starts on the same lease, still naming the newest child.
    expect(await startedStages(manager, 2)).toBe(true);
    // The lease is re-attributed to the newest child: a failed transfer would
    // have logged it, and the record names that child rather than stage 1's.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logs.join(' ')).not.toContain('still names this window');
    expect((await readLease()).pid).toBe(4242);
    manager.resolve();
    expect(await leaseReleased()).toBe(true);
    expect(started.executionId).toBe('exec-1');
  });

  it('ends the chain without rendering when the next stage cannot be prepared', async () => {
    const manager = fakeManager();
    await startMediaRender(
      {
        ...request(),
        next: () => Promise.reject(new Error('no Flamingo lyric text in this run')),
      },
      depsFor(manager),
    );
    manager.resolve();
    expect(await leaseReleased()).toBe(true);
    expect(manager.starts.length).toBe(1);
  });

  it('refuses to take the lease at all when another render holds it', async () => {
    const holder = await acquireMediaGpuLease('media:video:ltx25', 2, {
      leasePath,
      pid: 99,
      processStartTime: 111,
      lookupProcessStartTime: async (pid) => (pid === 99 ? 111 : undefined),
    });
    const deps = depsFor(fakeManager(false), {
      lookupProcessStartTime: async (pid) => (pid === 99 ? 111 : 1000),
    });
    await expect(startMediaRender(request(), deps)).rejects.toThrow(/one lock for every media GPU/);
    expect((await readLease()).pid).toBe(99);
    await holder.release();
  });

  it('holds the lease after an aborted wait, until the child itself is terminal', async () => {
    // Forge's rule for a background job: stopping the turn silences its notice
    // (`disarmNotify`), it does not kill the job. Handing the lease back while
    // this child still holds VRAM would let a second render start on top of it.
    let releases = 0;
    const manager = fakeManager();
    const controller = new AbortController();
    const deps = depsFor(manager, {
      acquireLease: async () => ({
        record: {
          pid: 10,
          process_start_time: 1_000,
          owner: 'media:video:ltx25',
          gpu: 2,
          started_at: new Date().toISOString(),
        },
        transfer: async () => undefined,
        release: async () => {
          releases += 1;
        },
      }),
    });
    await startMediaRender({ ...request(), abortSignal: controller.signal }, deps);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Aborted, and the child is still running: the lease is still held.
    expect(releases).toBe(0);
    manager.resolve({ status: 'failed', exitCode: 1 });
    for (let attempt = 0; attempt < 200 && releases === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Released once, and only now that the child is terminal.
    expect(releases).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(releases).toBe(1);
  });

  it('starts no further stage once the turn is aborted', async () => {
    const manager = fakeManager();
    const logs: string[] = [];
    const controller = new AbortController();
    const second = request({ engineId: 'ace_step' });
    await startMediaRender(
      {
        ...request(),
        abortSignal: controller.signal,
        next: () => Promise.resolve(second),
      },
      depsFor(manager, { log: (line) => logs.push(line) }),
    );
    controller.abort();
    manager.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The stage that was running was waited out; the cancelled turn starts none.
    expect(manager.starts.length).toBe(1);
    expect(logs.join(' ')).toContain('was stopped after stage 1');
    expect(await leaseReleased()).toBe(true);
  });

  it('wakes the chat only for the final stage of a two-stage run', async () => {
    const manager = fakeManager();
    const second = request({ engineId: 'ace_step' });
    await startMediaRender({ ...request(), next: () => Promise.resolve(second) }, depsFor(manager));
    manager.resolve();
    expect(await startedStages(manager, 2)).toBe(true);
    const analysisStage = manager.starts[0];
    const renderStage = manager.starts[1];
    // An MP3 analysis stage must not wake the chat with a "completed" notice.
    expect(analysisStage.notifyConversationId).toBeUndefined();
    expect(analysisStage.exitSummary).toBeUndefined();
    expect(renderStage.notifyConversationId).toBe('conversation-1');
    expect(typeof renderStage.exitSummary).toBe('function');
    manager.resolve();
    expect(await leaseReleased()).toBe(true);
  });

  it('runs the finished-file hook once after the final child completes', async () => {
    const manager = fakeManager();
    const onFinished = vi.fn(async () => undefined);
    await startMediaRender(request({ onFinished }), depsFor(manager));
    manager.resolve({ status: 'completed', exitCode: 0 });
    expect(await leaseReleased()).toBe(true);
    expect(onFinished).toHaveBeenCalledOnce();
    expect(onFinished).toHaveBeenCalledWith({ status: 'completed', exitCode: 0 });
  });

  it('moves the analysis manifest aside so the notice reads the render stage', async () => {
    const manager = fakeManager();
    const second = request({ engineId: 'ace_step' });
    await startMediaRender({ ...request(), next: () => Promise.resolve(second) }, depsFor(manager));
    // The analysis stage completed, and wrote the manifest its stage owns.
    await fs.writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ run_id: 'm-run-1', engine: 'flamingo_dlt', status: 'completed' }),
      'utf8',
    );
    manager.resolve();
    expect(await startedStages(manager, 2)).toBe(true);
    // Kept as the analysis record, but renamed aside before the render spawns.
    expect(await fs.readFile(path.join(root, 'analysis-manifest.json'), 'utf8')).toContain(
      'completed',
    );
    await expect(fs.readFile(path.join(root, 'manifest.json'), 'utf8')).rejects.toThrow(/ENOENT/);
    // The render stage ends non-zero without writing a manifest of its own.
    manager.resolve({ status: 'failed', exitCode: 1 });
    expect(await leaseReleased()).toBe(true);
    const notice = await mediaOutcomeNotice(root);
    expect(notice.completed).toBe(false);
    expect(notice.lines.join(' ')).toContain('ended without a manifest');
  });

  it('does not start the next stage when the earlier manifest cannot be archived', async () => {
    const manager = fakeManager();
    const logs: string[] = [];
    await fs.mkdir(path.join(root, 'analysis-manifest.json'));
    await fs.writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ run_id: 'm-run-1', engine: 'flamingo_dlt', status: 'completed' }),
      'utf8',
    );
    const second = request({ engineId: 'ace_step' });
    await startMediaRender(
      { ...request(), next: () => Promise.resolve(second) },
      depsFor(manager, { log: (line) => logs.push(line) }),
    );
    manager.resolve();
    expect(await leaseReleased()).toBe(true);
    expect(manager.starts).toHaveLength(1);
    expect(logs.join(' ')).toContain('The next stage was not started');
  });
});
