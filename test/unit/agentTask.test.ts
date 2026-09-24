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
import { FileLease } from '../../src/util/FileLease';
import {
  AgentTaskOutcome,
  AgentTaskRunner,
  canStartNow,
  parseResult,
  schedulePeriodMs,
  type AgentTaskDeps,
} from '../../src/jobs/agentTask';
import {
  restartAfterTurn,
  type RestartAfterTurnDeps,
} from '../../src/jobs/agentTaskRestart';
import { JobSchema, JobStateSchema, type Job, type JobFile } from '../../src/jobs/jobSchema';
import type { PowerControl } from '../../src/system/PowerControl';
import type { IBackendPool } from '../../src/backend/poolTypes';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { ForgeRequestOutcome } from '../../src/sidebar/turnOutcome';
import { readOutboxItem } from '../../src/jobs/JobOutbox';
import { openDiscussChat } from '../../src/jobs/jobDiscuss';
import { nextDueWithBackoff } from '../../src/jobs/backoff';

// ── Fakes ────────────────────────────────────────────────────────────────────

function fakePower(): PowerControl {
  return {
    holdAwake: () => ({ dispose: () => undefined }),
    setScheduledWakes: async () => undefined,
  } as unknown as PowerControl;
}

function fakePool(loaded: string[], capacity = 1): IBackendPool {
  return {
    loadedModelNames: () => loaded,
    loadedModelsExcept: (model: string) => loaded.filter((name) => name !== model.split('@')[0]),
    isLoaded: (model: string) => loaded.includes(model.split('@')[0]),
    parallelCapacity: () => capacity,
  } as unknown as IBackendPool;
}

function fakeConversation(id: string) {
  return {
    id,
    title: 'test',
    activeModel: null,
    archived: false,
    updatedAt: 0,
    requestCount: 0,
    toolCallCount: 0,
  };
}

function fakeHost(
  streaming: string[],
  sendResult: ForgeRequestOutcome,
  conversationId = 'conv-1',
): ForgeHostFacade {
  return {
    status: () => ({
      activeConversationId: '',
      conversations: [],
      requestChains: [],
      streamingConversationIds: streaming,
    }),
    send: vi.fn().mockResolvedValue(sendResult),
    restoreConversation: vi.fn().mockResolvedValue(fakeConversation(conversationId)),
    createConversation: vi.fn().mockResolvedValue(fakeConversation('conv-new')),
    setConversationModel: vi.fn().mockResolvedValue(undefined),
    unloadModels: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    queueIntent: vi.fn(),
    addApprovalSink: vi.fn().mockReturnValue({ dispose: () => undefined }),
    resolveApproval: vi.fn(),
    addQuestionSink: vi.fn().mockReturnValue({ dispose: () => undefined }),
    answerQuestion: vi.fn().mockReturnValue(false),
    dismissQuestion: vi.fn().mockReturnValue(false),
    clankerMode: vi.fn().mockReturnValue(false),
    setClankerMode: vi.fn(),
    contextBudget: vi.fn().mockReturnValue(undefined),
    compact: vi.fn().mockResolvedValue({ outcome: 'ok' }),
    unloadConversationModel: vi.fn().mockResolvedValue({ model: 'm', wasLoaded: false }),
    restartModel: vi.fn().mockResolvedValue(undefined),
    recentExchanges: vi.fn().mockReturnValue([]),
  } as unknown as ForgeHostFacade;
}

function baseJob(overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    version: 1,
    id: 'agent-task',
    name: 'Agent task',
    enabled: true,
    wake: false,
    after: 'stay_awake',
    schedule: { kind: 'interval', minutes: 15 },
    check: { kind: 'none' },
    on_change: { kind: 'notify' },
    action: { kind: 'agent_task', task: 'do the task' },
    created_at: 0,
    updated_at: 0,
    ...overrides,
  });
}

// ── canStartNow (AC8) ────────────────────────────────────────────────────────

describe('canStartNow', () => {
  it('starts when its model is resident and nothing is streaming', () => {
    const pool = fakePool(['qwen'], 1);
    expect(canStartNow('qwen', null, pool, [])).toMatchObject({ start: true });
  });

  it('starts when nothing is loaded', () => {
    const pool = fakePool([], 1);
    expect(canStartNow('qwen', null, pool, [])).toMatchObject({ start: true });
  });

  it('starts when a different model is resident but nothing is streaming', () => {
    const pool = fakePool(['other'], 1);
    expect(canStartNow('qwen', null, pool, [])).toMatchObject({ start: true });
  });

  it('starts with n_parallel 2 and one other chat streaming on the same model (AC8)', () => {
    const pool = fakePool(['qwen'], 2);
    expect(canStartNow('qwen', null, pool, ['other-chat'])).toMatchObject({ start: true });
  });

  it('waits when its own chat is streaming', () => {
    const pool = fakePool(['qwen'], 2);
    expect(canStartNow('qwen', 'own-chat', pool, ['own-chat'])).toMatchObject({
      start: false,
    });
  });

  it('waits when it needs a different model while one is streaming', () => {
    const pool = fakePool(['other'], 1);
    expect(canStartNow('qwen', null, pool, ['other-chat'])).toMatchObject({ start: false });
  });

  it('treats its own model as resident when the job names a profile', () => {
    const pool = fakePool(['qwen'], 2);
    expect(canStartNow('qwen@main', null, pool, ['other-chat'])).toMatchObject({ start: true });
  });

  it('waits when two other models are loaded and one is streaming (2026-09-23)', () => {
    const pool = fakePool(['qwopus', 'q6'], 4);
    expect(canStartNow('qwen@main', null, pool, ['user-chat'])).toMatchObject({ start: false });
  });

  it('waits when its model and another are loaded and something streams', () => {
    const pool = fakePool(['qwen', 'q6'], 4);
    expect(canStartNow('qwen', null, pool, ['user-chat'])).toMatchObject({ start: false });
  });

  it('waits when all parallel slots are streaming', () => {
    const pool = fakePool(['qwen'], 2);
    expect(canStartNow('qwen', null, pool, ['a', 'b'])).toMatchObject({ start: false });
  });
});

// ── parseResult (AC5) ────────────────────────────────────────────────────────

describe('parseResult', () => {
  it('parses RESULT: ok', () => {
    expect(parseResult('some text\nRESULT: ok — all done')).toMatchObject({
      kind: 'ok',
      sentence: 'all done',
    });
  });

  it('parses RESULT: no_change', () => {
    expect(parseResult('RESULT: no_change — nothing new')).toMatchObject({
      kind: 'no_change',
      sentence: 'nothing new',
    });
  });

  it('parses RESULT: failed', () => {
    expect(parseResult('RESULT: failed — the install broke')).toMatchObject({
      kind: 'failed',
      sentence: 'the install broke',
    });
  });

  it('no RESULT line → failed', () => {
    expect(parseResult('I did some work but forgot the result line')).toMatchObject({
      kind: 'failed',
      sentence: 'agent ended without a RESULT line',
    });
  });

  it('parses RESTART: yes', () => {
    expect(parseResult('RESULT: ok — done\nRESTART: yes')).toMatchObject({
      kind: 'ok',
      restart: true,
    });
  });

  it('no RESTART line → restart false', () => {
    expect(parseResult('RESULT: ok — done')).toMatchObject({ restart: false });
  });
});

// ── schedulePeriodMs ─────────────────────────────────────────────────────────

describe('schedulePeriodMs', () => {
  const now = Date.parse('2026-01-01T12:00:00');

  it('interval: minutes * 60000', () => {
    expect(schedulePeriodMs({ kind: 'interval', minutes: 15 }, now)).toBe(15 * 60_000);
  });

  it('daily: gap to next due (at least 60s)', () => {
    const ms = schedulePeriodMs({ kind: 'daily', at: '03:00' }, now);
    expect(ms).toBeGreaterThanOrEqual(60_000);
  });

  it('weekly: gap to next due (at least 60s)', () => {
    const ms = schedulePeriodMs(
      { kind: 'weekly', days: ['Mon'], at: '03:00' },
      now,
    );
    expect(ms).toBeGreaterThanOrEqual(60_000);
  });
});

describe('shared job backoff', () => {
  const now = new Date('2026-01-01T12:00:00');

  it('computes normal, doubled, and capped due times from one helper', () => {
    const schedule = { kind: 'interval' as const, minutes: 15 };
    expect(nextDueWithBackoff(schedule, now, 2)).toBe(now.getTime() + 15 * 60_000);
    expect(nextDueWithBackoff(schedule, now, 3)).toBe(now.getTime() + 30 * 60_000);
    expect(nextDueWithBackoff(schedule, now, 20)).toBe(now.getTime() + 24 * 60 * 60_000);
  });
});

// ── Crash / reload recovery (AC7) ────────────────────────────────────────────

describe('crash recovery (AC7)', () => {
  let jobsRoot: string;
  let store: JobStore;

  beforeEach(async () => {
    jobsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-agent-task-recovery-'));
    store = new JobStore(jobsRoot);
    spawnAndWait.mockReset();
    spawnAndWait.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  afterEach(async () => {
    await fs.promises.rm(jobsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('leftover task_run on start → interrupted outbox item, failed run row, task_run cleared', async () => {
    const job = baseJob();
    await store.saveJob(job);
    // Seed a leftover task_run as if Forge died mid-run.
    const startedAt = Date.parse('2026-01-01T03:00:00');
    store.patchState('agent-task', {
      task_run: { started_at: startedAt, conversation_id: 'conv-1' },
    });

    const scheduler = new JobScheduler({
      store,
      power: fakePower(),
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }),
      workspaceId: 'ws',
      instanceId: 'inst',
      leaseDirectory: jobsRoot,
      outboxDir: path.join(jobsRoot, 'outbox'),
      now: () => new Date('2026-01-01T04:00:00'),
      notifyLocal: () => undefined,
      tickMs: 30_000,
    });
    await scheduler.start({ immediate: false });
    try {
      // One outbox item containing "interrupted".
      const item = await readOutboxItem(path.join(jobsRoot, 'outbox'), 'agent-task');
      expect(item).toBeDefined();
      expect(item!.text).toContain('interrupted');

      // One failed run row.
      const runs = await store.readRuns('agent-task');
      expect(runs).toHaveLength(1);
      expect(runs[0]!.outcome).toBe('failed');
      expect(runs[0]!.summary).toContain('interrupted');

      // task_run cleared.
      const state = (await store.load('agent-task'))!.state;
      expect(state.task_run).toBeNull();
    } finally {
      await scheduler.stop();
    }
  });

  it('no leftover task_run → no recovery action', async () => {
    const job = baseJob();
    await store.saveJob(job);

    const scheduler = new JobScheduler({
      store,
      power: fakePower(),
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }),
      workspaceId: 'ws',
      instanceId: 'inst',
      leaseDirectory: jobsRoot,
      outboxDir: path.join(jobsRoot, 'outbox'),
      now: () => new Date('2026-01-01T04:00:00'),
      notifyLocal: () => undefined,
      tickMs: 30_000,
    });
    await scheduler.start({ immediate: false });
    try {
      const item = await readOutboxItem(path.join(jobsRoot, 'outbox'), 'agent-task');
      expect(item).toBeUndefined();
      const runs = await store.readRuns('agent-task');
      expect(runs).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });

  it('a non-owner window does not recover the owner window\'s live task', async () => {
    const job = baseJob();
    await store.saveJob(job);
    store.patchState('agent-task', {
      task_run: { started_at: Date.parse('2026-01-01T03:00:00'), conversation_id: 'conv-1' },
    });
    const ownerLease = await FileLease.acquire({
      directory: jobsRoot,
      key: 'jobs-scheduler',
      workspaceId: 'ws-owner',
      instanceId: 'owner',
      onLost: () => undefined,
    });
    const scheduler = new JobScheduler({
      store,
      power: fakePower(),
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }),
      workspaceId: 'ws',
      instanceId: 'non-owner',
      leaseDirectory: jobsRoot,
      outboxDir: path.join(jobsRoot, 'outbox'),
      now: () => new Date('2026-01-01T04:00:00'),
      notifyLocal: () => undefined,
      tickMs: 30_000,
    });
    try {
      expect(await scheduler.start({ immediate: false })).toBe(false);
      expect((await store.load('agent-task'))!.state.task_run).not.toBeNull();
      expect(await store.readRuns('agent-task')).toEqual([]);
      expect(await readOutboxItem(path.join(jobsRoot, 'outbox'), 'agent-task')).toBeUndefined();
    } finally {
      await scheduler.stop();
      await ownerLease.release();
    }
  });
});

describe('lease takeover while the old window is alive', () => {
  let jobsRoot: string;
  let store: JobStore;

  beforeEach(async () => {
    jobsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-agent-task-takeover-'));
    store = new JobStore(jobsRoot);
  });

  afterEach(async () => {
    await fs.promises.rm(jobsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('leaves a heartbeating run alone and recovers it once the beats stop', async () => {
    await store.saveJob(baseJob());
    const startedAt = Date.parse('2026-01-01T03:00:00');
    let now = startedAt + 60_000;
    // Another window's run, refreshed 30 s ago: that window is alive.
    store.patchState('agent-task', {
      task_run: { started_at: startedAt, conversation_id: 'conv-1', heartbeat_at: now - 30_000 },
    });
    const run = vi.fn();
    const scheduler = new JobScheduler({
      store,
      power: fakePower(),
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }),
      workspaceId: 'ws',
      instanceId: 'new-owner',
      leaseDirectory: jobsRoot,
      outboxDir: path.join(jobsRoot, 'outbox'),
      now: () => new Date(now),
      notifyLocal: () => undefined,
      tickMs: 30_000,
      agentTask: { run } as unknown as AgentTaskDeps,
    });
    const runSpy = vi.spyOn(AgentTaskRunner.prototype, 'run').mockResolvedValue(undefined);
    try {
      await store.requestRun('agent-task');
      expect(await scheduler.start({ immediate: false })).toBe(true);
      await scheduler.tick();
      expect(runSpy).not.toHaveBeenCalled();
      expect((await store.load('agent-task'))!.state.task_run).not.toBeNull();
      expect(await store.readRuns('agent-task')).toEqual([]);

      // The old window died: no beat for longer than the stale limit.
      now += 5 * 60_000;
      await scheduler.tick();
      const runs = await store.readRuns('agent-task');
      expect(runs[0]!.summary).toContain('interrupted');
      // The kept run_now request and the due schedule run it once, here.
      expect(runSpy).toHaveBeenCalledTimes(1);
    } finally {
      runSpy.mockRestore();
      await scheduler.stop();
    }
  });
});

// ── Runner full run ──────────────────────────────────────────────────────────

describe('AgentTaskRunner', () => {
  let jobsRoot: string;
  let store: JobStore;
  let outboxDir: string;
  let host: ForgeHostFacade;
  let pool: IBackendPool;
  let toasts: string[];

  function makeDeps(overrides: Partial<AgentTaskDeps> = {}): AgentTaskDeps {
    return {
      store,
      power: fakePower(),
      host: () => host,
      pool: () => pool,
      defaultModel: () => 'qwen',
      outboxDir,
      notifyLocal: (text) => toasts.push(text),
      busy: () => undefined,
      now: () => Date.parse('2026-01-01T03:00:00'),
      ...overrides,
    };
  }

  beforeEach(async () => {
    jobsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-agent-task-run-'));
    store = new JobStore(jobsRoot);
    outboxDir = path.join(jobsRoot, 'outbox');
    toasts = [];
    jobsFetch.mockReset();
    pool = fakePool(['qwen'], 1);
    host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1300' });
  });

  afterEach(async () => {
    await fs.promises.rm(jobsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('runs a turn, records an ok run row, clears task_run, and delivers the report', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 'install', report: 'always' } });
    await store.saveJob(job);

    const runner = new AgentTaskRunner(makeDeps());
    const jobFile: JobFile = { job, state: JobStateSchema.parse({}) };
    await runner.run(jobFile, false);

    const state = (await store.load('agent-task'))!.state;
    expect(state.task_run).toBeNull();
    expect(state.task_pending).toBe(false);
    expect(state.consecutive_failures).toBe(0);

    const runs = await store.readRuns('agent-task');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('ok');
    expect(runs[0]!.summary).toContain('installed b1300');

    // report: always → delivered.
    const item = await readOutboxItem(outboxDir, 'agent-task');
    expect(item).toBeDefined();
    expect(item!.text).toContain('ok');
  });

  it('releases a model the job had to load once nothing streams', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 't', model: 'qwen@main' } });
    await store.saveJob(job);
    const loaded: string[] = ['q6'];
    pool = fakePool(loaded, 1);
    const release = vi.fn(async () => undefined);
    Object.assign(pool, { release });
    vi.mocked(host.unloadModels).mockImplementation(async () => {
      loaded.splice(0, loaded.length);
    });
    vi.mocked(host.send).mockImplementation(async () => {
      loaded.push('qwen');
      return { kind: 'completed', finalText: 'RESULT: ok' };
    });

    await new AgentTaskRunner(makeDeps()).run({ job, state: JobStateSchema.parse({}) }, false);

    expect(host.unloadModels).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('qwen@main');
  });

  it('leaves a model that was already resident when the job started', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 't', model: 'qwen@main' } });
    await store.saveJob(job);
    const release = vi.fn(async () => undefined);
    Object.assign(pool, { release });

    await new AgentTaskRunner(makeDeps()).run({ job, state: JobStateSchema.parse({}) }, false);

    expect(host.unloadModels).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('the prompt carries the observation it was handed, and success saves it', async () => {
    const job = baseJob();
    await store.saveJob(job);
    store.patchState('agent-task', { last_observation: '{"tag":"b1"}' });
    host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b2' });

    const runner = new AgentTaskRunner(makeDeps());
    const saved = (await store.load('agent-task'))!.state;
    await runner.run({ job, state: { ...saved, last_observation: '{"tag":"b2"}' } }, false);

    const prompt = JSON.stringify(vi.mocked(host.send).mock.calls);
    expect(prompt).toContain('b2');
    expect(prompt).not.toContain('b1');
    expect((await store.load('agent-task'))!.state.last_observation).toBe('{"tag":"b2"}');
  });

  it('a failed run keeps the old observation, so the next check retries', async () => {
    const job = baseJob();
    await store.saveJob(job);
    store.patchState('agent-task', { last_observation: '{"tag":"b1"}' });
    host = fakeHost([], { kind: 'failed', error: 'download failed' });

    const runner = new AgentTaskRunner(makeDeps());
    const saved = (await store.load('agent-task'))!.state;
    await runner.run({ job, state: { ...saved, last_observation: '{"tag":"b2"}' } }, false);

    expect((await store.load('agent-task'))!.state.last_observation).toBe('{"tag":"b1"}');
  });

  it('a failed turn records a failed run row and delivers immediately', async () => {
    const job = baseJob({
      action: { kind: 'agent_task', task: 'install', report: 'failures_and_changes' },
    });
    await store.saveJob(job);
    host = fakeHost([], { kind: 'failed', error: 'model OOM' });

    const runner = new AgentTaskRunner(makeDeps());
    const jobFile: JobFile = { job, state: JobStateSchema.parse({}) };
    await runner.run(jobFile, false);

    const runs = await store.readRuns('agent-task');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('failed');
    expect(runs[0]!.error).toContain('model OOM');

    // Every failure is reported immediately (AC5).
    const item = await readOutboxItem(outboxDir, 'agent-task');
    expect(item).toBeDefined();
    expect(item!.text).toContain('failed');
  });

  it('no RESULT line → failed run row', async () => {
    const job = baseJob();
    await store.saveJob(job);
    host = fakeHost([], { kind: 'completed', finalText: 'I did work but no result line' });

    const runner = new AgentTaskRunner(makeDeps());
    const jobFile: JobFile = { job, state: JobStateSchema.parse({}) };
    await runner.run(jobFile, false);

    const runs = await store.readRuns('agent-task');
    expect(runs[0]!.outcome).toBe('failed');
    expect(runs[0]!.summary).toContain('RESULT');
  });

  it('an ok outcome is delivered under failures_and_changes (a change IS a change)', async () => {
    const job = baseJob({
      action: { kind: 'agent_task', task: 'install', report: 'failures_and_changes' },
    });
    await store.saveJob(job);
    host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b9999' });

    const runner = new AgentTaskRunner(makeDeps());
    await runner.run({ job, state: JobStateSchema.parse({}) }, false);

    const item = await readOutboxItem(outboxDir, 'agent-task');
    expect(item).toBeDefined();
  });

  it('no_change is delivered under always', async () => {
    const job = baseJob({
      action: { kind: 'agent_task', task: 'check', report: 'always' },
    });
    await store.saveJob(job);
    host = fakeHost([], { kind: 'completed', finalText: 'RESULT: no_change — nothing new' });

    const runner = new AgentTaskRunner(makeDeps());
    await runner.run({ job, state: JobStateSchema.parse({}) }, false);

    expect(await readOutboxItem(outboxDir, 'agent-task')).toBeDefined();
  });

  it('no_change outcome does not deliver under failures_and_changes (only run log)', async () => {
    const job = baseJob({
      action: { kind: 'agent_task', task: 'check', report: 'failures_and_changes' },
    });
    await store.saveJob(job);
    host = fakeHost([], { kind: 'completed', finalText: 'RESULT: no_change — nothing new' });

    const runner = new AgentTaskRunner(makeDeps());
    const jobFile: JobFile = { job, state: JobStateSchema.parse({}) };
    await runner.run(jobFile, false);

    const runs = await store.readRuns('agent-task');
    expect(runs[0]!.outcome).toBe('ok');
    expect(runs[0]!.changed).toBe(false);
    // no_change is not delivered under failures_and_changes.
    const item = await readOutboxItem(outboxDir, 'agent-task');
    expect(item).toBeUndefined();
  });

  it('records task_pending when no slot is free, and clears it on the next run', async () => {
    const job = baseJob();
    await store.saveJob(job);
    // All slots streaming on the same model → cannot start.
    pool = fakePool(['qwen'], 1);
    host = fakeHost(['other-chat'], { kind: 'completed', finalText: 'RESULT: ok — done' });

    const runner = new AgentTaskRunner(makeDeps());
    let jobFile: JobFile = { job, state: JobStateSchema.parse({}) };
    await runner.run(jobFile, false);

    // Pending recorded.
    const state1 = (await store.load('agent-task'))!.state;
    expect(state1.task_pending).toBe(true);
    expect(state1.task_pending_since).not.toBeNull();
    expect(state1.task_run).toBeNull();

    // Now a slot is free → the next run starts and clears pending.
    host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — done' });
    jobFile = { job, state: (await store.load('agent-task'))!.state };
    await runner.run(jobFile, false);

    const state2 = (await store.load('agent-task'))!.state;
    expect(state2.task_pending).toBe(false);
    expect(state2.task_pending_since).toBeNull();
    expect(state2.task_run).toBeNull();
  });

  it('retries a pending task without rerunning an unchanged check', async () => {
    const job = baseJob({
      check: { kind: 'github_issue', repo: 'ggml-org/llama.cpp', issue_number: 1 },
    });
    await store.saveJob(job);
    jobsFetch
      .mockResolvedValueOnce({
        notModified: false,
        body: JSON.stringify({ updated_at: '2026-01-01T03:00:00Z' }),
        etag: 'e1',
      })
      .mockResolvedValueOnce({ notModified: false, body: '[]', etag: 'e1-comments' })
      .mockResolvedValueOnce({
        notModified: false,
        body: JSON.stringify({ updated_at: '2026-01-01T03:15:00Z' }),
        etag: 'e2',
      })
      .mockResolvedValueOnce({ notModified: false, body: '[]', etag: 'e2-comments' })
      .mockResolvedValue({ notModified: true, body: '', etag: 'e2' });

    let nowMs = Date.parse('2026-01-01T03:00:00');
    pool = fakePool(['qwen'], 1);
    host = fakeHost(['other-chat'], { kind: 'completed', finalText: 'RESULT: ok — done' });
    let resolveRunnerFinished: () => void = () => undefined;
    const runnerFinished = new Promise<void>((resolve) => {
      resolveRunnerFinished = resolve;
    });
    const appendRun = store.appendRun.bind(store);
    vi.spyOn(store, 'appendRun').mockImplementation(async (id, row) => {
      await appendRun(id, row);
      if (id === 'agent-task' && row.changed) resolveRunnerFinished();
    });
    const scheduler = new JobScheduler({
      store,
      power: fakePower(),
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }),
      workspaceId: 'ws',
      instanceId: 'scheduler',
      leaseDirectory: jobsRoot,
      outboxDir,
      now: () => new Date(nowMs),
      notifyLocal: () => undefined,
      tickMs: 30_000,
      agentTask: makeDeps({ now: () => nowMs }),
    });
    try {
      await scheduler.start({ immediate: false });
      await scheduler.tick(); // establish the check baseline

      nowMs += 15 * 60_000;
      await scheduler.tick(); // changed check, but the only slot is busy
      expect((await store.load('agent-task'))!.state.task_pending).toBe(true);
      expect(host.send).not.toHaveBeenCalled();

      let resolveSend: (o: ForgeRequestOutcome) => void = () => undefined;
      host = {
        ...fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — retried' }),
        send: vi.fn().mockImplementation(
          () => new Promise<ForgeRequestOutcome>((resolve) => (resolveSend = resolve)),
        ),
      } as unknown as ForgeHostFacade;
      nowMs += 1_000;
      await scheduler.tick();
      expect(host.send).toHaveBeenCalledOnce();
      expect(jobsFetch).toHaveBeenCalledTimes(4);
      resolveSend({ kind: 'completed', finalText: 'RESULT: ok — retried' });
      await Promise.race([
        runnerFinished,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('pending runner did not finish')), 1_000),
        ),
      ]);
      const done = (await store.load('agent-task'))!.state;
      expect(done.task_run).toBeNull();
      expect(done.task_pending).toBe(false);
      expect(done.task_pending_observation).toBeNull();
      // The retry acts on and saves the change it was deferred on, not the
      // pre-change baseline, so the next check does not see it again.
      const prompt = (host.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
      expect(prompt).toContain('03:15:00Z');
      expect(done.last_observation).toContain('03:15:00Z');
    } finally {
      await scheduler.stop();
    }
  });

  it('keeps a run_now request for a running agent task until the run ends', async () => {
    const job = baseJob();
    await store.saveJob(job);
    let nowMs = Date.parse('2026-01-01T03:00:00');
    let resolveSend: (o: ForgeRequestOutcome) => void = () => undefined;
    host = {
      ...fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — done' }),
      send: vi.fn().mockImplementation(
        () => new Promise<ForgeRequestOutcome>((resolve) => (resolveSend = resolve)),
      ),
    } as unknown as ForgeHostFacade;
    const scheduler = new JobScheduler({
      store,
      power: fakePower(),
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }),
      workspaceId: 'ws',
      instanceId: 'scheduler',
      leaseDirectory: jobsRoot,
      outboxDir,
      now: () => new Date(nowMs),
      notifyLocal: () => undefined,
      tickMs: 30_000,
      agentTask: makeDeps({ now: () => nowMs }),
    });
    try {
      await scheduler.start({ immediate: false });
      await scheduler.tick(); // due: the detached run starts and waits on send
      await vi.waitFor(() => expect(host.send).toHaveBeenCalledOnce());

      await store.requestRun('agent-task');
      nowMs += 30_000;
      await scheduler.tick(); // still running: the request must survive
      const marker = path.join(jobsRoot, 'run_requests', 'agent-task');
      expect(fs.existsSync(marker)).toBe(true);

      resolveSend({ kind: 'completed', finalText: 'RESULT: ok — done' });
      await vi.waitFor(async () =>
        expect((await store.load('agent-task'))!.state.task_run).toBeNull(),
      );
      await vi.waitFor(async () => expect(await store.readRuns('agent-task')).toHaveLength(1));
      nowMs += 30_000;
      await scheduler.tick(); // the run ended: the request runs now
      expect(fs.existsSync(marker)).toBe(false);
      await vi.waitFor(() => expect(host.send).toHaveBeenCalledTimes(2));
      resolveSend({ kind: 'completed', finalText: 'RESULT: ok — done' });
      await vi.waitFor(async () => expect(await store.readRuns('agent-task')).toHaveLength(2));
    } finally {
      await scheduler.stop();
    }
  });

  it('drops a pending task older than one schedule period with a skipped run row', async () => {
    const job = baseJob({ schedule: { kind: 'interval', minutes: 15 } });
    await store.saveJob(job);
    pool = fakePool(['qwen'], 1);
    // The slot is busy (another chat streaming on the only slot), so the run
    // cannot start and the stale pending is dropped.
    host = fakeHost(['other-chat'], { kind: 'completed', finalText: 'RESULT: ok — done' });
    // Pending since 20 minutes ago (period is 15 min).
    const oldPendingAt = Date.parse('2026-01-01T02:40:00');
    const state = JobStateSchema.parse({
      task_pending: true,
      task_pending_since: oldPendingAt,
    });

    // now is 03:00, pending since 02:40 → 20 min > 15 min period.
    const runner = new AgentTaskRunner(makeDeps());
    const jobFile: JobFile = { job, state };
    await runner.run(jobFile, false);

    const runs = await store.readRuns('agent-task');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('skipped');
    expect(runs[0]!.summary).toContain('busy');

    const state2 = (await store.load('agent-task'))!.state;
    expect(state2.task_pending).toBe(false);
    expect(state2.task_pending_since).toBeNull();
    // The job waits for its next scheduled time instead of re-pending next tick.
    expect(state2.next_due_at).toBe(Date.parse('2026-01-01T03:15:00'));
  });

  it('a blocked CLI agent waits for its next scheduled time and clears a pending task', async () => {
    const job = baseJob({ schedule: { kind: 'interval', minutes: 15 } });
    await store.saveJob(job);
    const state = JobStateSchema.parse({
      task_pending: true,
      task_pending_since: Date.parse('2026-01-01T02:55:00'),
      task_pending_observation: '"seen"',
    });
    const runner = new AgentTaskRunner(
      makeDeps({
        cliAgentSkip: (model, at, late) => ({
          at,
          late,
          outcome: 'skipped',
          changed: false,
          summary: `skipped: ${model} is a CLI agent`,
          delivered: 0,
        }),
      }),
    );
    await runner.run({ job, state }, false);

    const runs = await store.readRuns('agent-task');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('skipped');
    const after = (await store.load('agent-task'))!.state;
    expect(after.next_due_at).toBe(Date.parse('2026-01-01T03:15:00'));
    expect(after.task_pending).toBe(false);
    expect(after.task_pending_observation).toBeNull();
    expect(host.send).not.toHaveBeenCalled();
  });

  it('marks the conversation unattended and disposes the marker in finally', async () => {
    const job = baseJob();
    await store.saveJob(job);
    host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — done' });

    const runner = new AgentTaskRunner(makeDeps());
    const jobFile: JobFile = { job, state: JobStateSchema.parse({}) };
    await runner.run(jobFile, false);

    // The marker is disposed in finally: the conversation is no longer unattended.
    const { unattendedConversations } = await import('../../src/sidebar/unattendedConversations');
    const convId = (await store.load('agent-task'))!.state.conversation_id;
    // conversation_id was set by the runner; the marker was disposed.
    expect(convId).not.toBeNull();
    expect(unattendedConversations.has(convId!)).toBe(false);
  });

  it('max_minutes cap cancels the turn and records a timeout', async () => {
    const job = baseJob({
      action: { kind: 'agent_task', task: 'install', max_minutes: 1, report: 'failures_and_changes' },
    });
    await store.saveJob(job);
    // The send stays pending until the cap fires and cancels it; cancel
    // settles the send promise (as the real host does), so the turn unwinds.
    let cancelCalled = false;
    let resolveSend: (o: ForgeRequestOutcome) => void = () => undefined;
    const sendPromise = new Promise<ForgeRequestOutcome>((resolve) => {
      resolveSend = resolve;
    });
    host = {
      ...fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — done' }),
      send: vi.fn().mockImplementation(() => sendPromise),
      cancel: vi.fn().mockImplementation(async () => {
        cancelCalled = true;
        resolveSend({ kind: 'cancelled', finalText: '' });
      }),
    } as unknown as ForgeHostFacade;

    // Use a fast sleep so the cap fires quickly in the test.
    const runner = new AgentTaskRunner(
      makeDeps({ sleep: () => new Promise((r) => setTimeout(r, 50)) }),
    );
    const jobFile: JobFile = { job, state: JobStateSchema.parse({}) };
    await runner.run(jobFile, false);

    expect(cancelCalled).toBe(true);
    const runs = await store.readRuns('agent-task');
    expect(runs[0]!.outcome).toBe('failed');
    expect(runs[0]!.summary).toContain('timed out');
  });

  it('normal completion cancels the cap without waiting for its sleep', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 'install', max_minutes: 1, report: 'failures_and_changes' } });
    await store.saveJob(job);
    let aborted = false;
    host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — done' });
    const runner = new AgentTaskRunner(
      makeDeps({
        sleep: (_ms, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('timer aborted'));
            });
          }),
      }),
    );

    const jobFile: JobFile = { job, state: JobStateSchema.parse({}) };
    await runner.run(jobFile, false);

    expect(aborted).toBe(true);
    expect(host.cancel).not.toHaveBeenCalled();
    expect((await store.load('agent-task'))!.state.task_run).toBeNull();
  });

  it('waits for an already-fired cap cancellation to settle', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 'install', max_minutes: 1, report: 'failures_and_changes' } });
    await store.saveJob(job);
    let resolveSend: (o: ForgeRequestOutcome) => void = () => undefined;
    let resolveCancel: () => void = () => undefined;
    const sendPromise = new Promise<ForgeRequestOutcome>((resolve) => {
      resolveSend = resolve;
    });
    const cancelPromise = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    let cancelCalled = false;
    host = {
      ...fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — done' }),
      send: vi.fn().mockImplementation(() => sendPromise),
      cancel: vi.fn().mockImplementation(async () => {
        cancelCalled = true;
        resolveSend({ kind: 'cancelled', finalText: '' });
        await cancelPromise;
      }),
    } as unknown as ForgeHostFacade;
    const runner = new AgentTaskRunner(makeDeps({ sleep: async () => undefined }));
    const jobFile: JobFile = { job, state: JobStateSchema.parse({}) };
    const run = runner.run(jobFile, false);
    await vi.waitFor(() => expect(cancelCalled).toBe(true));
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    resolveCancel();
    await run;
  });
});

// ── openDiscussChat refusal (AC12) ──────────────────────────────────────────

describe('openDiscussChat refusal (AC12)', () => {
  let jobsRoot: string;
  let store: JobStore;

  beforeEach(async () => {
    jobsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-agent-task-discuss-'));
    store = new JobStore(jobsRoot);
  });

  afterEach(async () => {
    await fs.promises.rm(jobsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('refuses while task_run is set and sends nothing', async () => {
    const job = baseJob();
    await store.saveJob(job);
    store.patchState('agent-task', {
      task_run: { started_at: Date.now(), conversation_id: 'conv-1' },
    });

    const host = fakeHost([], { kind: 'completed', finalText: '' });
    const jobFile: JobFile = { job, state: (await store.load('agent-task'))!.state };

    await expect(openDiscussChat(host, store, jobFile, false)).rejects.toThrow(/running/);
    // No seed was sent.
    expect(host.send).not.toHaveBeenCalled();
  });
});

// ── Step 7: restart after the turn (phase 4) ────────────────────────────────

describe('restartAfterTurn (step 7, phase 4)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-agent-task-restart-'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** A parsed outcome as runTurn builds it: parseResult plus the text it came from. */
  function outcomeOf(finalText: string): AgentTaskOutcome {
    return { ...parseResult(finalText), finalText };
  }

  function restartDeps(overrides: Partial<RestartAfterTurnDeps> = {}): RestartAfterTurnDeps {
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — done' });
    return {
      host,
      pool: fakePool(['qwen'], 1),
      configPath: path.join(dir, 'config.yaml'),
      backupPath: path.join(dir, 'config.bak'),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...overrides,
    };
  }
  it('restarts on RESTART: yes AND RESULT: ok and keeps the ok outcome', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1234\nRESTART: yes' });
    const out = await restartAfterTurn({ ...restartDeps(), host }, 'qwen', ok);
    expect(out.kind).toBe('ok');
    expect(host.restartModel).toHaveBeenCalledWith('qwen');
  });

  it('does not restart when RESULT is not ok', async () => {
    const failed = outcomeOf('RESULT: failed — something broke');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: failed — something broke' });
    const out = await restartAfterTurn({ ...restartDeps(), host }, 'qwen', failed);
    expect(out.kind).toBe('failed');
    expect(host.restartModel).not.toHaveBeenCalled();
  });

  it('does not restart when RESTART is not yes', async () => {
    const ok = outcomeOf('RESULT: ok — done');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — done' });
    const out = await restartAfterTurn({ ...restartDeps(), host }, 'qwen', ok);
    expect(out.kind).toBe('ok');
    expect(host.restartModel).not.toHaveBeenCalled();
  });

  it('notes the new binary takes effect on next load when no model is loaded', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1234\nRESTART: yes' });
    const out = await restartAfterTurn({ ...restartDeps(), host, pool: fakePool([], 1) }, 'qwen', ok);
    expect(out.kind).toBe('ok');
    expect(out.sentence).toContain('no model loaded');
    expect(host.restartModel).not.toHaveBeenCalled();
  });

  it('rolls back and restarts when the first restart throws', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const backupPath = path.join(dir, 'config.bak');
    const configPath = path.join(dir, 'config.yaml');
    await fs.promises.writeFile(backupPath, 'llama_server:\n  binary: /old/binary\n');
    await fs.promises.writeFile(configPath, 'llama_server:\n  binary: /new/binary\n');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1234\nRESTART: yes' });
    let calls = 0;
    host.restartModel = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('new binary did not start');
    });
    const out = await restartAfterTurn(
      { ...restartDeps(), host, backupPath, configPath },
      'qwen',
      ok,
    );
    expect(out.kind).toBe('failed');
    // Acceptance #6: the report names BOTH binaries.
    expect(out.sentence).toContain('/new/binary');
    expect(out.sentence).toContain('/old/binary');
    expect(out.sentence).toContain('rolled back to /old/binary');
    expect(host.restartModel).toHaveBeenCalledTimes(2);
    const restored = await fs.promises.readFile(configPath, 'utf8');
    expect(restored).toContain('/old/binary');
  });

  it('reports a manual fix when the rollback restart also fails', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const backupPath = path.join(dir, 'config.bak');
    const configPath = path.join(dir, 'config.yaml');
    await fs.promises.writeFile(backupPath, 'llama_server:\n  binary: /old/binary\n');
    await fs.promises.writeFile(configPath, 'llama_server:\n  binary: /new/binary\n');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1234\nRESTART: yes' });
    host.restartModel = vi.fn().mockRejectedValue(new Error('no binary works'));
    const out = await restartAfterTurn(
      { ...restartDeps(), host, backupPath, configPath },
      'qwen',
      ok,
    );
    expect(out.kind).toBe('failed');
    expect(out.sentence).toContain('also failed to start');
    expect(out.sentence).toContain('fix llama_server.binary manually');
    // Acceptance #6: the report names BOTH binaries.
    expect(out.sentence).toContain('/new/binary');
    expect(out.sentence).toContain('/old/binary');
    expect(host.restartModel).toHaveBeenCalledTimes(2);
  });

  it('counts a cap hit as a failed restart and rolls back', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const backupPath = path.join(dir, 'config.bak');
    const configPath = path.join(dir, 'config.yaml');
    await fs.promises.writeFile(backupPath, 'llama_server:\n  binary: /old/binary\n');
    await fs.promises.writeFile(configPath, 'llama_server:\n  binary: /new/binary\n');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1234\nRESTART: yes' });
    let calls = 0;
    host.restartModel = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) return new Promise<void>(() => {}); // hangs → cap
      return Promise.resolve();
    });
    // The cap fires quickly (50 ms) regardless of the requested duration, so the
    // hanging first restart loses the race to the cap.
    const sleep = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        const t = setTimeout(resolve, 50);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        }, { once: true });
      });
    const out = await restartAfterTurn(
      { ...restartDeps(), host, backupPath, configPath, sleep },
      'qwen',
      ok,
    );
    // The cap hit counts as a failed restart: the first (hanging) restart loses
    // the race to the cap, so the runner rolls back and restarts once more.
    expect(out.kind).toBe('failed');
    expect(out.sentence).toContain('rolled back to /old/binary');
    expect(host.restartModel).toHaveBeenCalledTimes(2);
  });

  it('returns a failed outcome (never throws) when the first restart throws synchronously', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const backupPath = path.join(dir, 'config.bak');
    const configPath = path.join(dir, 'config.yaml');
    await fs.promises.writeFile(backupPath, 'llama_server:\n  binary: /old/binary\n');
    await fs.promises.writeFile(configPath, 'llama_server:\n  binary: /new/binary\n');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1234\nRESTART: yes' });
    // Synchronous throw (not a rejected promise) on the first restart: the
    // "never throws" contract must still hold, and the rollback still runs.
    // Call 2 returns a real promise (a conforming restartModel is async).
    let calls = 0;
    host.restartModel = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) throw new Error('sync failure');
      return Promise.resolve();
    });
    const out = await restartAfterTurn(
      { ...restartDeps(), host, backupPath, configPath },
      'qwen',
      ok,
    );
    expect(out.kind).toBe('failed');
    expect(out.sentence).toContain('rolled back to /old/binary');
    expect(host.restartModel).toHaveBeenCalledTimes(2);
  });

  it('cancels the cap timer on a normal finish so it never outlives the call', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    let aborted = false;
    const sleep = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(t);
          reject(new Error('aborted'));
        }, { once: true });
      });
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1234\nRESTART: yes' });
    await restartAfterTurn({ ...restartDeps(), host, sleep }, 'qwen', ok);
    expect(host.restartModel).toHaveBeenCalledTimes(1);
    expect(aborted).toBe(true);
  });

  it('reports ok when the retry loads the new binary and there is no snapshot to roll back to', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const configPath = path.join(dir, 'config.yaml');
    await fs.promises.writeFile(configPath, 'llama_server:\n  binary: /new/binary\n');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1234\nRESTART: yes' });
    let calls = 0;
    host.restartModel = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('new binary did not start');
    });
    // No backup snapshot: restoreConfig is a no-op, so the retry is what loads
    // the new binary. It must NOT report a rollback that never happened.
    const out = await restartAfterTurn(
      { ...restartDeps(), host, backupPath: undefined, configPath },
      'qwen',
      ok,
    );
    expect(out.kind).toBe('ok');
    expect(out.sentence).toContain('loaded on retry');
    expect(out.sentence).not.toContain('rolled back');
    expect(host.restartModel).toHaveBeenCalledTimes(2);
  });

  it('does not claim a rollback when a snapshot exists but the live config path is unknown', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const backupPath = path.join(dir, 'config.bak');
    await fs.promises.writeFile(backupPath, 'llama_server:\n  binary: /old/binary\n');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1234\nRESTART: yes' });
    let calls = 0;
    host.restartModel = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('new binary did not start');
    });
    // Nothing can be restored without the live path, so the retry is what loaded.
    const out = await restartAfterTurn(
      { ...restartDeps(), host, backupPath, configPath: undefined },
      'qwen',
      ok,
    );
    expect(out.kind).toBe('ok');
    expect(out.sentence).not.toContain('rolled back');
  });

  it('reports a manual fix when the retry fails and there is no snapshot to roll back to', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const configPath = path.join(dir, 'config.yaml');
    await fs.promises.writeFile(configPath, 'llama_server:\n  binary: /new/binary\n');
    const host = fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — installed b1234\nRESTART: yes' });
    host.restartModel = vi.fn().mockRejectedValue(new Error('no binary works'));
    const out = await restartAfterTurn(
      { ...restartDeps(), host, backupPath: undefined, configPath },
      'qwen',
      ok,
    );
    expect(out.kind).toBe('failed');
    expect(out.sentence).toContain('no snapshot to roll back to');
    expect(out.sentence).toContain('fix llama_server.binary manually');
    expect(host.restartModel).toHaveBeenCalledTimes(2);
  });
});
