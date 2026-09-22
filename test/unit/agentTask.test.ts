import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnAndWait } = vi.hoisted(() => ({ spawnAndWait: vi.fn() }));
vi.mock('../../src/util/processSpawn', () => ({ spawnAndWait }));

import { JobStore } from '../../src/jobs/JobStore';
import { JobScheduler } from '../../src/jobs/JobScheduler';
import {
  AgentTaskRunner,
  canStartNow,
  parseResult,
  schedulePeriodMs,
  type AgentTaskDeps,
} from '../../src/jobs/agentTask';
import { JobSchema, JobStateSchema, type Job, type JobFile } from '../../src/jobs/jobSchema';
import type { PowerControl } from '../../src/system/PowerControl';
import type { IBackendPool } from '../../src/backend/poolTypes';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { ForgeRequestOutcome } from '../../src/sidebar/turnOutcome';
import { readOutboxItem } from '../../src/jobs/JobOutbox';
import { openDiscussChat } from '../../src/jobs/jobDiscuss';

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

  it('no_change outcome does not deliver (only run log)', async () => {
    const job = baseJob({
      action: { kind: 'agent_task', task: 'check', report: 'always' },
    });
    await store.saveJob(job);
    host = fakeHost([], { kind: 'completed', finalText: 'RESULT: no_change — nothing new' });

    const runner = new AgentTaskRunner(makeDeps());
    const jobFile: JobFile = { job, state: JobStateSchema.parse({}) };
    await runner.run(jobFile, false);

    const runs = await store.readRuns('agent-task');
    expect(runs[0]!.outcome).toBe('ok');
    // no_change is not delivered even with report: always.
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
      action: { kind: 'agent_task', task: 'install', max_minutes: 1 },
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
