import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnAndWait, jobsFetch } = vi.hoisted(() => ({
  spawnAndWait: vi.fn(),
  jobsFetch: vi.fn(),
}));
vi.mock('../../src/util/processSpawn', () => ({ spawnAndWait }));
vi.mock('../../src/jobs/jobsFetch', () => ({ jobsFetch }));

import { JobStore } from '../../src/jobs/JobStore';
import { JobScheduler } from '../../src/jobs/JobScheduler';
import { PowerControl } from '../../src/system/PowerControl';
import { JobSchema, type Job } from '../../src/jobs/jobSchema';
import { FileLease } from '../../src/util/FileLease';

let jobsRoot: string;
let outboxDir: string;
let store: JobStore;
let power: PowerControl;
let nowMs: number;
let busyReason: string | undefined;
let summarizeCalls: string[];
let toasts: string[];

function makeJob(overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    version: 1,
    id: 'disk',
    name: 'Disk',
    enabled: true,
    wake: false,
    after: 'stay_awake',
    schedule: { kind: 'interval', minutes: 15 },
    check: { kind: 'disk_space', path: jobsRoot, min_free_gb: 1 },
    on_change: { kind: 'notify' },
    action: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  });
}

/** A GitHub issue body for a given comment count (the check tracks it). */
function issueBody(comments: number): string {
  return JSON.stringify({
    state: 'open',
    updated_at: `2026-01-01T00:${String(comments).padStart(2, '0')}:00Z`,
    title: 'Win CUDA build',
    comments,
  });
}

let scheduler: JobScheduler;

function makeScheduler(options: { maxConcurrent?: number } = {}) {
  scheduler = new JobScheduler({
    store,
    power,
    getConfig: () => ({
      allowedHosts: ['api.github.com'],
      maxConcurrent: options.maxConcurrent ?? 2,
    }),
    workspaceId: 'ws',
    instanceId: 'inst',
    leaseDirectory: jobsRoot,
    outboxDir,
    now: () => new Date(nowMs),
    busy: () => busyReason,
    summarize: async (prompt) => {
      summarizeCalls.push(prompt);
      return 'SUMMARY';
    },
    notifyLocal: (message) => toasts.push(message),
    tickMs: 30_000,
  });
}

beforeEach(async () => {
  jobsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-'));
  outboxDir = path.join(jobsRoot, 'outbox');
  store = new JobStore(jobsRoot);
  power = new PowerControl();
  nowMs = Date.parse('2026-01-01T00:00:00');
  busyReason = undefined;
  summarizeCalls = [];
  toasts = [];
  spawnAndWait.mockReset();
  spawnAndWait.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

afterEach(async () => {
  // Release the lease and clear the tick interval so the test process can exit.
  await scheduler?.stop();
  await fs.promises.rm(jobsRoot, { recursive: true, force: true });
});

describe('JobScheduler tick', () => {
  it('runs a due disk_space job once, records the run, and advances next_due_at', async () => {
    await store.saveJob(makeJob());
    makeScheduler();
    // tick() is gated on holding the lease; start() acquires it. immediate:
    // false so the test drives ticks itself (no surprise baseline tick).
    await scheduler.start({ immediate: false });
    await scheduler.tick();

    const runs = await store.readRuns('disk');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('ok');
    expect(runs[0]!.late).toBe(false);
    const state = (await store.load('disk'))!.state;
    expect(state.next_due_at).toBe(nowMs + 15 * 60_000);
    expect(state.last_run_at).toBe(nowMs);
    expect(state.consecutive_failures).toBe(0);
  });

  it('a change is delivered as a toast and an outbox file', async () => {
    await store.saveJob(
      makeJob({ check: { kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1 } }),
    );
    makeScheduler();
    await scheduler.start({ immediate: false });
    // Baseline: the first run records the observation and reports no change.
    jobsFetch.mockResolvedValue({
      notModified: false,
      body: issueBody(1),
      etag: 'e1',
    });
    await scheduler.tick();
    expect(toasts).toHaveLength(0);

    // A new comment changes the observation; the change is delivered.
    jobsFetch.mockResolvedValue({
      notModified: false,
      body: issueBody(2),
      etag: 'e2',
    });
    nowMs += 15 * 60_000;
    await scheduler.tick();

    expect(toasts.some((t) => t.includes('Disk'))).toBe(true);
    const outboxFiles = await fs.promises.readdir(outboxDir);
    expect(outboxFiles).toContain('disk.json');
  });

  it('a failed check is backed off after 3 consecutive failures', async () => {
    // A disk_space check on a path that does not exist throws.
    await store.saveJob(
      makeJob({ check: { kind: 'disk_space', path: path.join(jobsRoot, 'nope'), min_free_gb: 1 } }),
    );
    makeScheduler();
    await scheduler.start({ immediate: false });
    for (let i = 0; i < 3; i++) {
      // Advance the clock first so the job is due for this tick.
      nowMs += 15 * 60_000;
      await scheduler.tick();
    }
    const state = (await store.load('disk'))!.state;
    expect(state.consecutive_failures).toBe(3);
    // After the 3rd failure the job is backed off: next_due_at is pushed out
    // past the current clock.
    expect(state.next_due_at).toBeGreaterThan(nowMs);
  });

  it('a summarize change is deferred while a turn is streaming, then delivered when idle', async () => {
    await store.saveJob(
      makeJob({
        check: { kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1 },
        on_change: { kind: 'summarize', focus: ['release_notes'] },
      }),
    );
    makeScheduler();
    await scheduler.start({ immediate: false });
    // Baseline: no change, nothing pending.
    jobsFetch.mockResolvedValue({ notModified: false, body: issueBody(1), etag: 'e1' });
    await scheduler.tick();

    // A change arrives while a turn is streaming: it is recorded and the
    // summarize is deferred (the model must not fight a live turn for the GPU).
    jobsFetch.mockResolvedValue({ notModified: false, body: issueBody(2), etag: 'e2' });
    busyReason = 'a turn is streaming';
    nowMs += 15 * 60_000;
    await scheduler.tick();
    let state = (await store.load('disk'))!.state;
    expect(state.summary_pending).toBe(true);
    expect(summarizeCalls).toHaveLength(0);

    // Once idle, the pending summary runs and is delivered.
    jobsFetch.mockResolvedValue({ notModified: false, body: issueBody(2), etag: 'e2' });
    busyReason = undefined;
    nowMs += 15 * 60_000;
    await scheduler.tick();
    state = (await store.load('disk'))!.state;
    expect(state.summary_pending).toBe(false);
    expect(summarizeCalls).toHaveLength(1);
  });

  it('no lease means no runs', async () => {
    await store.saveJob(makeJob());
    makeScheduler();
    // Simulate another window already holding the scheduler lease.
    const otherLease = await FileLease.acquire({
      directory: jobsRoot,
      key: 'jobs-scheduler',
      workspaceId: 'ws-test',
      instanceId: 'other',
      onLost: () => undefined,
    });
    // start() cannot take the lease, so it reports it did not start.
    expect(await scheduler.start({ immediate: false })).toBe(false);
    // A direct tick is also gated on the lease: nothing runs.
    await scheduler.tick();
    const state = (await store.load('disk'))!.state;
    expect(state.last_run_at).toBeNull();
    expect(await store.readRuns('disk')).toEqual([]);
    await scheduler.stop();
    await otherLease.release();
  });

  it('a job never runs twice at once (no double run)', async () => {
    await store.saveJob(
      makeJob({ check: { kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1 } }),
    );
    makeScheduler();
    await scheduler.start({ immediate: false });
    // The first run is still in flight (a slow fetch). A second tick must not
    // start the same job again.
    let release: () => void = () => undefined;
    jobsFetch.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ notModified: false, body: issueBody(1), etag: 'e1' });
      }),
    );
    const first = scheduler.tick();
    await scheduler.tick(); // must be a no-op while the first is running
    release();
    await first;
    // Exactly one run row: the in-flight run. The second tick did not double-run.
    expect(await store.readRuns('disk')).toHaveLength(1);
  });

  it('a late tick after a long gap runs the overdue job once, marked late', async () => {
    await store.saveJob(makeJob());
    makeScheduler();
    await scheduler.start({ immediate: false });
    // First run at the baseline clock: records the run, sets next_due_at.
    await scheduler.tick();
    expect(await store.readRuns('disk')).toHaveLength(1);
    // The machine was off for far longer than the resume gap (90 s) and past
    // the 15-minute interval; the job is now overdue. On resume it runs exactly
    // once, flagged late.
    nowMs += 16 * 60_000;
    await scheduler.tick();
    const runs = await store.readRuns('disk');
    expect(runs).toHaveLength(2);
    expect(runs[1]!.late).toBe(true);
  });

  // schtasks is Windows-only; off Windows a real wake request is refused.
  it.skipIf(process.platform !== 'win32')(
    'disabling a wake job deletes its scheduled wake',
    async () => {
      await store.saveJob(makeJob({ wake: true, schedule: { kind: 'daily', at: '06:00' } }));
      makeScheduler();
      await scheduler.start({ immediate: false });
      // On lease acquisition the wake task is registered for the enabled job.
      expect(spawnAndWait).toHaveBeenCalled();
      spawnAndWait.mockClear();
      // Disable the job and reconcile: the task is deleted, not left stale.
      const job = (await store.load('disk'))!.job;
      await store.saveJob({ ...job, enabled: false });
      await scheduler.reconcileWakes();
      // deleteScheduledWakes calls spawnAndWait(schtasks, ['/delete', ...]).
      const deleteCalls = spawnAndWait.mock.calls.filter(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('/delete'),
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
    },
  );
});

describe('JobScheduler run_now markers (AC5)', () => {
  it('consumes a run_requests marker and runs the job on that tick', async () => {
    await store.saveJob(makeJob());
    // Not due: next_due_at is in the future. An explicit request overrides it.
    await store.saveState('disk', {
      last_run_at: nowMs,
      last_ok_at: nowMs,
      last_observation: '1.0',
      consecutive_failures: 0,
      next_due_at: nowMs + 60 * 60_000,
      conversation_id: null,
      summary_pending: false,
    });
    await store.requestRun('disk');
    makeScheduler();
    await scheduler.start({ immediate: false });

    await scheduler.tick();

    const runs = await store.readRuns('disk');
    expect(runs).toHaveLength(1);
    // The marker is consumed, so it cannot fire again.
    expect(await store.consumeRunRequests()).toEqual([]);
  });

  it('runs a PAUSED job on an explicit marker (a request overrides enabled)', async () => {
    await store.saveJob(makeJob({ enabled: false }));
    await store.requestRun('disk');
    makeScheduler();
    await scheduler.start({ immediate: false });

    await scheduler.tick();

    expect(await store.readRuns('disk')).toHaveLength(1);
  });

  it('consumes the marker BEFORE the run, so a crash mid-run cannot re-fire it', async () => {
    // The ordering is the invariant: a marker still on disk when the run starts
    // would re-run a job every tick after a crash. Force the run to fail and
    // assert the marker is gone regardless.
    await store.saveJob(
      makeJob({ check: { kind: 'disk_space', path: path.join(jobsRoot, 'nope'), min_free_gb: 1 } }),
    );
    await store.requestRun('disk');
    makeScheduler();
    await scheduler.start({ immediate: false });

    await scheduler.tick();

    const runs = await store.readRuns('disk');
    expect(runs.some((r) => r.outcome === 'failed')).toBe(true);
    expect(await store.consumeRunRequests()).toEqual([]);
  });

  it('does not run a job twice when a marker and the schedule both fire', async () => {
    await store.saveJob(makeJob());
    await store.requestRun('disk');
    makeScheduler();
    await scheduler.start({ immediate: false });

    await scheduler.tick();

    expect(await store.readRuns('disk')).toHaveLength(1);
  });
});

describe('JobScheduler maxConcurrent (AC4)', () => {
  /** Three jobs whose checks block, so overlap is observable. */
  async function seedThreeBlockingJobs(): Promise<void> {
    for (const id of ['a', 'b', 'c']) {
      await store.saveJob(
        makeJob({
          id,
          name: id,
          check: { kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1 },
        }),
      );
    }
  }

  /** Track the high-water mark of simultaneous in-flight checks. */
  function trackConcurrency(): { peak: () => number } {
    let inFlight = 0;
    let peak = 0;
    jobsFetch.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { notModified: false, body: issueBody(1), etag: null };
    });
    return { peak: () => peak };
  }

  afterEach(() => {
    jobsFetch.mockReset();
  });

  it('runs at most maxConcurrent jobs at a time', async () => {
    await seedThreeBlockingJobs();
    const tracker = trackConcurrency();
    makeScheduler({ maxConcurrent: 1 });
    await scheduler.start({ immediate: false });

    await scheduler.tick();

    expect(tracker.peak()).toBe(1);
    // All three still ran, just not at once.
    for (const id of ['a', 'b', 'c']) {
      expect(await store.readRuns(id)).toHaveLength(1);
    }
  });

  it('honours a higher limit without exceeding it', async () => {
    await seedThreeBlockingJobs();
    const tracker = trackConcurrency();
    makeScheduler({ maxConcurrent: 2 });
    await scheduler.start({ immediate: false });

    await scheduler.tick();

    expect(tracker.peak()).toBe(2);
  });
});

describe('JobScheduler lease loss (audit F2)', () => {
  it('re-acquires on the next tick instead of dying permanently', async () => {
    await store.saveJob(makeJob());
    makeScheduler();
    expect(await scheduler.start({ immediate: false })).toBe(true);

    // Simulate the lease going away: the heartbeat fails, or another window
    // steals it. Disposing here is what made a transient loss permanent —
    // silently, with the wake task still armed.
    (scheduler as unknown as { handleLeaseLost(): void }).handleLeaseLost();
    await fs.promises.rm(path.join(jobsRoot, 'jobs-scheduler.lease.json'), { force: true });

    nowMs += 15 * 60_000;
    await scheduler.tick();

    expect(await store.readRuns('disk')).toHaveLength(1);
  });

  it('stop() is still final — a disposed scheduler does not come back', async () => {
    await store.saveJob(makeJob());
    makeScheduler();
    await scheduler.start({ immediate: false });
    await scheduler.stop();

    nowMs += 15 * 60_000;
    await scheduler.tick();

    expect(await store.readRuns('disk')).toEqual([]);
  });
});

describe('JobScheduler failure reporting (audit F7)', () => {
  it('reports a failing job ONCE, at the backoff threshold, not every run', async () => {
    await store.saveJob(
      makeJob({ check: { kind: 'disk_space', path: path.join(jobsRoot, 'nope'), min_free_gb: 1 } }),
    );
    makeScheduler();
    await scheduler.start({ immediate: false });

    // Six failing runs. Backoff pushes next_due_at out, so advance past it.
    for (let i = 0; i < 6; i++) {
      nowMs += 48 * 60 * 60_000;
      await scheduler.tick();
    }

    const failureToasts = toasts.filter((t) => t.includes('failing:'));
    expect(failureToasts).toHaveLength(1);
    // And one pending outbox item, not six deliveries.
    const outboxFiles = await fs.promises.readdir(outboxDir);
    expect(outboxFiles).toEqual(['disk.json']);
  });
});

describe('JobScheduler cold start (audit F9, D7)', () => {
  it('marks a job late that fell due while VS Code was closed', async () => {
    await store.saveJob(makeJob());
    // Overdue by two hours: the machine was off, or the window was closed.
    await store.saveState('disk', {
      last_run_at: nowMs - 3 * 60 * 60_000,
      last_ok_at: nowMs - 3 * 60 * 60_000,
      last_observation: '1.0',
      consecutive_failures: 0,
      next_due_at: nowMs - 2 * 60 * 60_000,
      conversation_id: null,
      summary_pending: false,
    });
    makeScheduler();
    await scheduler.start({ immediate: false });

    // The FIRST tick of the process: there is no previous tick to measure a
    // gap against, which is exactly why this case used to report late: false.
    await scheduler.tick();

    const runs = await store.readRuns('disk');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.late).toBe(true);
  });

  it('does not mark an on-time first run late', async () => {
    await store.saveJob(makeJob());
    makeScheduler();
    await scheduler.start({ immediate: false });

    await scheduler.tick();

    const runs = await store.readRuns('disk');
    expect(runs[0]!.late).toBe(false);
  });
});
