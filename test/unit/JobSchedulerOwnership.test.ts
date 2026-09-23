import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnAndWait } = vi.hoisted(() => ({ spawnAndWait: vi.fn() }));
vi.mock('../../src/util/processSpawn', () => ({ spawnAndWait }));

import { JobStore, isJobDefinitionName } from '../../src/jobs/JobStore';
import { JobScheduler } from '../../src/jobs/JobScheduler';
import { JobDelivery } from '../../src/jobs/JobDelivery';
import { readOutboxItem } from '../../src/jobs/JobOutbox';
import { WakeReconciler, clearWakesIfUnowned } from '../../src/jobs/schedulerWakes';
import { JobSchema, type Job } from '../../src/jobs/jobSchema';
import { FileLease } from '../../src/util/FileLease';
import type { PowerControl } from '../../src/system/PowerControl';

/**
 * Regressions for the 2026-09-21 weekly audit: scheduler takeover (A2), the
 * heartbeat-driven wake churn (A4), wake-task deletion by a non-owner (A7),
 * and deferred summaries on paused / failing jobs (A8, A9).
 */

let jobsRoot: string;
let store: JobStore;

function makeJob(overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    version: 1,
    id: 'disk',
    name: 'Disk',
    schedule: { kind: 'interval', minutes: 15 },
    check: { kind: 'disk_space', path: jobsRoot, min_free_gb: 1 },
    on_change: { kind: 'summarize' },
    ...overrides,
  });
}

function fakePower(): { calls: unknown[][]; power: PowerControl } {
  const calls: unknown[][] = [];
  const power = {
    setScheduledWakes: async (wakes: unknown[]) => void calls.push(wakes),
    holdAwake: () => ({ dispose: () => undefined }),
  } as unknown as PowerControl;
  return { calls, power };
}

const holdLease = (instanceId: string): Promise<FileLease> =>
  FileLease.acquire({
    directory: jobsRoot,
    key: 'jobs-scheduler',
    workspaceId: 'ws',
    instanceId,
    onLost: () => undefined,
  });

beforeEach(async () => {
  // Long form: libuv's Windows dir watcher asserts on an 8.3 short path
  // (CI's TEMP is C:\Users\RUNNER~1\...), crashing the worker.
  jobsRoot = fs.realpathSync.native(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-own-')),
  );
  store = new JobStore(jobsRoot);
  spawnAndWait.mockReset();
  spawnAndWait.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

afterEach(async () => {
  store.unwatch();
  // A tick may still be finishing its state write after stop().
  await fs.promises.rm(jobsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('scheduler takeover (audit A2)', () => {
  it('a window that lost the first acquisition takes over once the owner leaves', async () => {
    await store.saveJob(makeJob({ on_change: { kind: 'notify' } }));
    const owner = await holdLease('window-a');
    const scheduler = new JobScheduler({
      store,
      power: fakePower().power,
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }),
      workspaceId: 'ws',
      instanceId: 'window-b',
      leaseDirectory: jobsRoot,
      outboxDir: path.join(jobsRoot, 'outbox'),
      tickMs: 20,
    });
    try {
      expect(await scheduler.start()).toBe(false);
      await owner.release();
      // No manual tick: the passive interval must pick the lease up itself.
      await vi.waitFor(async () => expect(await store.readRuns('disk')).toHaveLength(1), {
        timeout: 2000,
      });
    } finally {
      await scheduler.stop();
    }
  });
});

describe('scheduler stop', () => {
  it('waits for a tick still in flight, so nothing writes after stop() returns', async () => {
    const scheduler = new JobScheduler({
      store,
      power: fakePower().power,
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }),
      workspaceId: 'ws',
      instanceId: 'window-a',
      leaseDirectory: jobsRoot,
      outboxDir: path.join(jobsRoot, 'outbox'),
    });
    expect(await scheduler.start({ immediate: false })).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(store, 'loadAll').mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const tick = scheduler.tick();
    let stopped = false;
    const stop = scheduler.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // CI failure 2026-09-23: the test removed the directory under a live tick.
    expect(stopped).toBe(false);
    release();
    await Promise.all([tick, stop]);
    expect(stopped).toBe(true);
  });
});

describe('wake reconciliation churn (audit A4)', () => {
  it('does not treat the lease heartbeat temporary as a job definition', () => {
    const heartbeat = `jobs-scheduler.lease.json.${'a'.repeat(8)}.heartbeat-1758480000000.tmp`;
    expect(isJobDefinitionName(heartbeat)).toBe(false);
    expect(isJobDefinitionName('jobs-scheduler.lease.json')).toBe(false);
    expect(isJobDefinitionName('.disk.json.forge-1-0.tmp')).toBe(false);
    expect(isJobDefinitionName('disk.json')).toBe(true);
  });

  it('a heartbeat temporary does not fire the store watch; a definition edit does', async () => {
    const onChange = vi.fn();
    await store.saveJob(makeJob());
    store.watch(onChange);
    // macOS FSEvents can hand a new watcher the saveJob write from just before
    // it started; let that (debounced) event land before counting.
    await new Promise((r) => setTimeout(r, 1300));
    onChange.mockClear();
    const tmp = path.join(jobsRoot, 'jobs-scheduler.lease.json.tok.heartbeat-1.tmp');
    await fs.promises.writeFile(tmp, '{}');
    await fs.promises.unlink(tmp);
    await new Promise((r) => setTimeout(r, 1300));
    expect(onChange).not.toHaveBeenCalled();
    await store.saveJob(makeJob({ name: 'Disk 2' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('registers an unchanged schedule once, and again after reset', async () => {
    const { calls, power } = fakePower();
    const wakes = new WakeReconciler(power);
    const schedule = [{ hour: 5, minute: 55, days: 'daily' as const }];
    await wakes.reconcile(schedule);
    await wakes.reconcile(schedule);
    expect(calls).toHaveLength(1);
    wakes.reset();
    await wakes.reconcile(schedule);
    expect(calls).toHaveLength(2);
  });

  it('retries a registration that failed rather than remembering it', async () => {
    let fail = true;
    const power = {
      setScheduledWakes: async () => {
        if (fail) throw new Error('schtasks exited 1');
      },
    };
    const wakes = new WakeReconciler(power);
    const schedule = [{ hour: 5, minute: 55, days: 'daily' as const }];
    await expect(wakes.reconcile(schedule)).rejects.toThrow('schtasks');
    fail = false;
    const spy = vi.spyOn(power, 'setScheduledWakes');
    await wakes.reconcile(schedule);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('wake task deletion by a jobs-disabled window (audit A7)', () => {
  const opts = (power: PowerControl) => ({
    power,
    directory: jobsRoot,
    workspaceId: 'ws',
    instanceId: 'disabled-window',
  });

  it('leaves the task alone while a live scheduler owns it', async () => {
    const owner = await holdLease('enabled-window');
    const { calls, power } = fakePower();
    expect(await clearWakesIfUnowned(opts(power))).toBe(false);
    expect(calls).toEqual([]);
    expect(await owner.verify()).toBe(true);
    await owner.release();
  });

  it('deletes a stale task when nobody owns it, and releases the lease', async () => {
    const { calls, power } = fakePower();
    expect(await clearWakesIfUnowned(opts(power))).toBe(true);
    expect(calls).toEqual([[]]);
    const next = await holdLease('enabled-window');
    await next.release();
  });
});

describe('deferred summaries (audit A8, A9)', () => {
  let nowMs: number;
  let outboxDir: string;
  let toasts: string[];

  const delivery = (summarize: (prompt: string) => Promise<string>): JobDelivery =>
    new JobDelivery({
      store,
      outboxDir,
      notifyLocal: (t) => toasts.push(t),
      busy: () => undefined,
      summarize,
      now: () => nowMs,
    });

  beforeEach(() => {
    nowMs = Date.parse('2026-09-21T12:00:00Z');
    outboxDir = path.join(jobsRoot, 'outbox');
    toasts = [];
  });

  it('a paused job does no model work for its pending summary', async () => {
    await store.saveJob(makeJob({ enabled: false }));
    store.patchState('disk', { summary_pending: true, last_observation: '{"free_gb":1}' });
    const summarize = vi.fn(async () => 'SUMMARY');
    await delivery(summarize).processPendingSummaries();
    expect(summarize).not.toHaveBeenCalled();
    expect((await store.load('disk'))!.state.summary_pending).toBe(true);
  });

  it('backs off a failing summary, reports once, and says when it recovered', async () => {
    await store.saveJob(makeJob());
    store.patchState('disk', { summary_pending: true, last_observation: '{"free_gb":1}' });
    let fail = true;
    const summarize = vi.fn(async () => {
      if (fail) throw new Error('model unavailable');
      return 'SUMMARY';
    });
    const d = delivery(summarize);

    await d.processPendingSummaries();
    let state = (await store.load('disk'))!.state;
    expect(state.summary_pending).toBe(true);
    expect(state.summary_failures).toBe(1);
    expect(state.summary_retry_at).toBe(nowMs + 60_000);
    expect((await readOutboxItem(outboxDir, 'disk'))!.text).toContain('model unavailable');

    // The next tick, 30 s later, is inside the backoff: no model call.
    nowMs += 30_000;
    await d.processPendingSummaries();
    expect(summarize).toHaveBeenCalledTimes(1);

    // Past it, a second failure doubles the wait and is not re-reported.
    nowMs += 31_000;
    await d.processPendingSummaries();
    state = (await store.load('disk'))!.state;
    expect(state.summary_failures).toBe(2);
    expect(state.summary_retry_at).toBe(nowMs + 120_000);
    expect((await readOutboxItem(outboxDir, 'disk'))!.earlier_count).toBe(0);

    fail = false;
    nowMs += 121_000;
    await d.processPendingSummaries();
    state = (await store.load('disk'))!.state;
    expect(state).toMatchObject({
      summary_pending: false,
      summary_failures: 0,
      summary_retry_at: null,
    });
    expect((await readOutboxItem(outboxDir, 'disk'))!.text).toContain('recovered');
  });
});
