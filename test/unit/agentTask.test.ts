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
  type AgentTaskAction,
  type AgentTaskDeps,
} from '../../src/jobs/agentTask';
import { reportMessage } from '../../src/jobs/agentTaskReport';
import { buildAgentTaskPrompt } from '../../src/jobs/agentTaskPrompt';
import {
  restartAfterTurn,
  RESTART_CAP_MS,
  type RestartAfterTurnDeps,
} from '../../src/jobs/agentTaskRestart';
import { JobSchema, JobStateSchema, type Job, type JobFile } from '../../src/jobs/jobSchema';
import { jobDefaultModel } from '../../src/config/jobsSchema';
import type { ForgeConfig } from '../../src/config/types';
import type { PowerControl } from '../../src/system/PowerControl';
import type { IBackendPool } from '../../src/backend/poolTypes';
import { userQuietGate, USER_QUIET_MS } from '../../src/jobs/agentTaskAdmission';
import { ChatCapacityError, type ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { chatCapMessage } from '../../src/sidebar/sessionTypes';
import type { ForgeRequestOutcome } from '../../src/sidebar/turnOutcome';
import { readOutboxItem } from '../../src/jobs/JobOutbox';
import { JobDelivery } from '../../src/jobs/JobDelivery';
import {
  recoverInterruptedRuns,
  startTaskRunHeartbeat,
} from '../../src/jobs/agentTaskState';
import { openDiscussChat, resolveJobConversation } from '../../src/jobs/jobDiscuss';
import { nextDueWithBackoff } from '../../src/jobs/backoff';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import { makeAskUserTool } from '../../src/tools/askUserTool';

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
      modelDemandConversationIds: streaming,
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

// ── userQuietGate ────────────────────────────────────────────────────────────

describe('userQuietGate', () => {
  const now = 100 * 60_000;
  it('waits while a user chat was updated within the quiet window', () => {
    const convs = [{ id: 'user', updatedAt: now - 3 * 60_000 }];
    expect(userQuietGate(convs, new Set(), now)).toBe('the user was active 3 min ago');
  });
  it("ignores the jobs' own conversations", () => {
    const convs = [{ id: 'job', updatedAt: now - 60_000 }];
    expect(userQuietGate(convs, new Set(['job']), now)).toBeUndefined();
  });
  it('lets the job start once the user has been quiet long enough', () => {
    const convs = [{ id: 'user', updatedAt: now - USER_QUIET_MS }];
    expect(userQuietGate(convs, new Set(), now)).toBeUndefined();
    expect(userQuietGate([], new Set(), now)).toBeUndefined();
  });
});

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

  it('keeps a question-waiting chat same-chat busy but releases its model demand', () => {
    const pool = fakePool(['other-model'], 1);
    expect(
      canStartNow('qwen', 'waiting-chat', pool, ['waiting-chat'], undefined, [], []),
    ).toMatchObject({ start: false, reason: 'its own conversation is streaming' });
    expect(canStartNow('qwen', null, pool, ['waiting-chat'], undefined, [], [])).toMatchObject({
      start: true,
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

  it('uses verified external serving slots across Forge windows', () => {
    const pool = fakePool([], 1);
    expect(canStartNow('strata', null, pool, [], { capacity: 2, inFlight: 1 })).toMatchObject({
      start: true,
    });
    expect(canStartNow('strata', null, pool, [], { capacity: 2, inFlight: 2 })).toMatchObject({
      start: false,
      reason: 'all 2 parallel slot(s) are streaming',
    });
  });

  it('does not assume a managed shared slot when status is unavailable', () => {
    const pool = fakePool(['strata'], 2);
    expect(
      canStartNow('strata', null, pool, ['live-chat'], undefined, [], ['live-chat'], true),
    ).toMatchObject({
      start: false,
      reason: 'cannot verify shared serving capacity for "strata" while a turn is active',
    });
    expect(
      canStartNow(
        'strata',
        null,
        pool,
        ['live-chat'],
        { capacity: 2, inFlight: 1 },
        [],
        ['live-chat'],
        true,
      ),
    ).toMatchObject({ start: true });
  });

  it('waits when another window holds a managed server the job would unload', () => {
    const pool = fakePool(['strata'], 1);
    const hold = {
      id: '4242-x',
      model: 'strata',
      pid: 4242,
      conversationId: 'chat-in-the-other-window',
      title: 'work chat',
      expiresAt: 0,
    };
    expect(canStartNow('qwen', null, pool, [], undefined, [hold])).toMatchObject({
      start: false,
      reason: `"strata" is held for a turn by chat 'work chat'`,
    });
    // Nothing to unload, so nothing to wait for: the held server is not this
    // window's to free, and a job may not be starved by an unrelated hold.
    expect(canStartNow('qwen', null, fakePool(['qwen'], 1), [], undefined, [hold])).toMatchObject({
      start: true,
    });
    // Two chats may share one managed server, so a hold on the model the job is
    // about to use is not a reason to wait.
    expect(canStartNow('strata', null, pool, [], undefined, [hold])).toMatchObject({ start: true });
    // A verified shared Strata slot means step 3 unloads nothing at all.
    expect(canStartNow('qwen', null, pool, [], { capacity: 2, inFlight: 0 }, [hold])).toMatchObject(
      { start: true },
    );
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

  /**
   * A task that names its own kinds — the Maya updater prints
   * `RESULT: updated - …` and its agent copies that line — used to land as
   * `failed`, because the runner only knew ok / no_change / failed.
   */
  it("a script's own wording (`updated`) is a success, not a failure", () => {
    expect(parseResult('RESULT: updated - Maya v1 -> v2; engine rebuilt')).toMatchObject({
      kind: 'ok',
      sentence: 'Maya v1 -> v2; engine rebuilt',
    });
  });

  it('`skipped` is its own kind, not a failure', () => {
    expect(parseResult('RESULT: skipped - Maya is running')).toMatchObject({
      kind: 'skipped',
      sentence: 'Maya is running',
    });
  });

  /**
   * The contract asks for an em dash; a script's own RESULT line uses an ASCII
   * one, and the kind word used to ride along into the summary because of it.
   */
  it('an ASCII dash separates the kind from the sentence too', () => {
    expect(parseResult('RESULT: failed - the patch does not apply')).toMatchObject({
      kind: 'failed',
      sentence: 'the patch does not apply',
    });
    expect(parseResult('RESULT: no_change - Maya v1.1.40 is the newest release')).toMatchObject({
      kind: 'no_change',
      sentence: 'Maya v1.1.40 is the newest release',
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

// ── reportMessage ────────────────────────────────────────────────────────────

describe('reportMessage', () => {
  const outcome = (finalText: string) =>
    ({ kind: 'ok', sentence: 'done', restart: false, finalText }) as AgentTaskOutcome;

  it('carries the whole final text, not a tail that starts mid-word', () => {
    const body = `Today's build is installed and verified.\n
${'Detail for the record: digests checked. '.repeat(40)}RESULT: ok — installed`;
    expect(body.length).toBeGreaterThan(800);
    const message = reportMessage(outcome(body), 0, 1_500, null);
    expect(message).toContain("Today's build is installed and verified.");
    expect(message).toContain('RESULT: ok — installed');
  });

  it('clips a runaway final text at the head, with a marker', () => {
    const message = reportMessage(outcome('x'.repeat(6_000)), 0, 1_000, null);
    expect(message).toContain('…(report clipped)');
    expect(message.length).toBeLessThan(4_200);
  });
});

// ── buildAgentTaskPrompt ─────────────────────────────────────────────────────

describe('buildAgentTaskPrompt', () => {
  const jobFile: JobFile = { job: baseJob(), state: JobStateSchema.parse({}) };
  const store = { readRuns: async () => [] } as unknown as JobStore;

  /** The stamp used to name Europe/Athens whatever the machine's own zone is
   * (CLAUDE.md: no hardcoded OS or user values). A job that fires at 03:00 UTC
   * on a machine in another zone now says the clock that machine reads. */
  it('names the local time zone in the scheduled run time', async () => {
    const action = baseJob().action as AgentTaskAction;
    const prompt = await buildAgentTaskPrompt(store, jobFile, action);
    expect(prompt).toContain(
      `(${Intl.DateTimeFormat().resolvedOptions().timeZone}, 24-hour format)`,
    );
    expect(prompt).toContain('Scheduled run time: ');
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
    const ms = schedulePeriodMs({ kind: 'weekly', days: ['Mon'], at: '03:00' }, now);
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
    await fs.promises.rm(jobsRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
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

  it("a non-owner window does not recover the owner window's live task", async () => {
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

  /** A tick's snapshot of one job, with the marker it held when the tick read it. */
  function staleSnapshot(startedAt: number, live: JobFile): JobFile {
    return {
      job: live.job,
      state: {
        ...live.state,
        task_run: { started_at: startedAt, conversation_id: 'conv-1' },
      },
    };
  }

  it('re-reads each job before acting on it, so a marker cleared mid-tick survives', async () => {
    await store.saveJob(baseJob());
    const startedAt = Date.parse('2026-01-01T03:00:00');
    store.patchState('agent-task', {
      task_run: { started_at: startedAt, conversation_id: 'conv-1' },
    });
    const snapshot = staleSnapshot(startedAt, (await store.load('agent-task'))!);
    // The run finished and cleared its marker while the loop read other jobs.
    store.patchState('agent-task', { task_run: null });

    const outboxDir = path.join(jobsRoot, 'outbox');
    const cleared = await recoverInterruptedRuns(
      store,
      outboxDir,
      () => Date.parse('2026-01-01T04:00:00'),
      { jobs: [snapshot], isOwn: () => false },
    );
    expect(cleared.size).toBe(0);
    expect(await store.readRuns('agent-task')).toEqual([]);
    expect(await readOutboxItem(outboxDir, 'agent-task')).toBeUndefined();
  });

  it('a marker that started beating again after the snapshot belongs to a live window', async () => {
    await store.saveJob(baseJob());
    const startedAt = Date.parse('2026-01-01T03:00:00');
    store.patchState('agent-task', {
      task_run: { started_at: startedAt, conversation_id: 'conv-1' },
    });
    const snapshot = staleSnapshot(startedAt, (await store.load('agent-task'))!);
    const nowMs = Date.parse('2026-01-01T04:00:00');
    // Another window picked the beat back up between the snapshot and this loop.
    store.patchState('agent-task', {
      task_run: { started_at: startedAt, conversation_id: 'conv-1', heartbeat_at: nowMs - 10_000 },
    });

    const outboxDir = path.join(jobsRoot, 'outbox');
    const cleared = await recoverInterruptedRuns(store, outboxDir, () => nowMs, {
      jobs: [snapshot],
      isOwn: () => false,
    });
    expect(cleared.size).toBe(0);
    expect(await store.readRuns('agent-task')).toEqual([]);
    expect((await store.load('agent-task'))!.state.task_run).not.toBeNull();
  });

  it('recovers a marker still stale on disk, claiming nothing about a restart', async () => {
    await store.saveJob(baseJob());
    const startedAt = Date.parse('2026-01-01T03:00:00');
    store.patchState('agent-task', {
      task_run: { started_at: startedAt, conversation_id: 'conv-1' },
    });
    const snapshot = staleSnapshot(startedAt, (await store.load('agent-task'))!);

    const outboxDir = path.join(jobsRoot, 'outbox');
    const cleared = await recoverInterruptedRuns(
      store,
      outboxDir,
      () => Date.parse('2026-01-01T04:00:00'),
      { jobs: [snapshot], isOwn: () => false },
    );
    expect(cleared).toEqual(new Set(['agent-task']));
    const item = await readOutboxItem(outboxDir, 'agent-task');
    expect(item).toBeDefined();
    expect(item!.text).toContain('no heartbeat for');
    expect(item!.text).not.toContain('Forge restarted');
    const runs = await store.readRuns('agent-task');
    expect(runs[0]!.summary).toContain('no heartbeat for');
    expect(runs[0]!.summary).not.toContain('Forge restarted');
  });
});

// ── The heartbeat that keeps a live run's marker fresh ───────────────────────

describe('task_run heartbeat', () => {
  /** The two store calls the beat makes, with the marker's owner visible. */
  function beatStore(marker: Record<string, unknown> | null) {
    const state: { task_run: Record<string, unknown> | null } = { task_run: marker };
    const patches: Array<Record<string, unknown>> = [];
    return {
      state,
      patches,
      load: async () => ({ state }),
      patchState: (_id: string, patch: Record<string, unknown>) => {
        patches.push(patch);
        Object.assign(state, patch);
      },
    };
  }
  const asStore = (s: ReturnType<typeof beatStore>): JobStore => s as unknown as JobStore;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refreshes the marker while it names this run', async () => {
    const s = beatStore({ started_at: 1_000, conversation_id: 'c' });
    const stop = startTaskRunHeartbeat(asStore(s), 'j', 1_000, () => 'c', () => 2_000);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(s.state.task_run).toMatchObject({ started_at: 1_000, heartbeat_at: 2_000 });
    } finally {
      stop();
    }
  });

  it('a beat landing after the marker was cleared does not put it back', async () => {
    const s = beatStore({ started_at: 1_000 });
    const stop = startTaskRunHeartbeat(asStore(s), 'j', 1_000, () => 'c', () => 2_000);
    try {
      s.state.task_run = null; // finish() cleared it before this beat ran
      await vi.advanceTimersByTimeAsync(30_000);
      expect(s.state.task_run).toBeNull();
      expect(s.patches.filter((p) => p['task_run'] !== null)).toEqual([]);
    } finally {
      stop();
    }
  });

  it('leaves a marker naming a newer run alone, and a stop does not clear it', async () => {
    const s = beatStore({ started_at: 1_000 });
    const stop = startTaskRunHeartbeat(asStore(s), 'j', 1_000, () => 'c', () => 2_000);
    s.state.task_run = { started_at: 5_000, heartbeat_at: 5_000 };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.state.task_run).toEqual({ started_at: 5_000, heartbeat_at: 5_000 });
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state.task_run).toEqual({ started_at: 5_000, heartbeat_at: 5_000 });
  });

  it('a stop clears the marker once more, in case a beat that read it first lands late', async () => {
    const s = beatStore({ started_at: 1_000 });
    const stop = startTaskRunHeartbeat(asStore(s), 'j', 1_000, () => 'c', () => 2_000);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(s.state.task_run).not.toBeNull();
      stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.patches[s.patches.length - 1]).toEqual({ task_run: null });
      expect(s.state.task_run).toBeNull();
    } finally {
      stop();
    }
  });

  it('a stop that reports an unfinished finish leaves the marker for recovery', async () => {
    const s = beatStore({ started_at: 1_000 });
    const stop = startTaskRunHeartbeat(asStore(s), 'j', 1_000, () => 'c', () => 2_000);
    await vi.advanceTimersByTimeAsync(30_000);
    stop(false); // finish() threw: no run row was written, no notice was sent
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state.task_run).not.toBeNull();
    // The beat is dead, so the marker ages and recovery can report the run.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.patches.filter((p) => p['task_run'] !== null)).toHaveLength(1);
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
    await fs.promises.rm(jobsRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
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
      // The tick that declares a run interrupted does not also start it again:
      // this tick cleared that marker, so the job counts as busy until the next
      // one. Starting it in the same breath is how a run that was still alive,
      // just not beating, used to end up running twice (BL-043).
      expect(runSpy).not.toHaveBeenCalled();
      // The kept run_now request and the due schedule run it once, here.
      await scheduler.tick();
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
      externalTurnHolds: () => [],
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
    await fs.promises.rm(jobsRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
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

  /**
   * BL-043 follow-up from Claude's review: the beat stops in the `finally`, and
   * a stop that cleared the marker after a `finish()` that threw left the run
   * with no row, no notice and no marker — invisible to recovery as well. The
   * stop now reports whether `finish()` got through, so the marker survives and
   * recovery writes the failed row it would write for any dead window.
   */
  it('a finish() that throws leaves the marker for recovery instead of losing the run', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 'install', report: 'always' } });
    await store.saveJob(job);
    const tryDeliver = vi
      .spyOn(JobDelivery.prototype, 'tryDeliver')
      .mockRejectedValue(new Error('delivery exploded'));
    try {
      await new AgentTaskRunner(makeDeps()).run({ job, state: JobStateSchema.parse({}) }, false);
    } catch (err) {
      expect(String(err)).toContain('delivery exploded');
    } finally {
      tryDeliver.mockRestore();
    }
    // The stop function's read-and-clear is a promise chain: settle it before
    // reading, or the assertion below passes whether or not the marker survived.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Nothing declared this run interrupted, and no row was written for it.
    const marker = (await store.load('agent-task'))!.state.task_run;
    expect(marker).not.toBeNull();
    expect(await store.readRuns('agent-task')).toEqual([]);

    // Recovery is what reports it, once the beat is older than the stale limit.
    const started = marker!.started_at;
    const cleared = await recoverInterruptedRuns(store, outboxDir, () => started + 5 * 60_000);
    expect(cleared).toEqual(new Set(['agent-task']));
    const runs = await store.readRuns('agent-task');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('failed');
    expect(runs[0]!.summary).toContain('no heartbeat for');
  });

  /**
   * A `jobs.default_model` naming a deleted model used to reach the backend and
   * die there as "unknown model", which read as a broken job. The runner
   * resolves the jobs model at the start, so the morning report names the field
   * to edit instead, and no turn is spent to find out.
   */
  it('fails at the start with the jobs-model message when the default model is gone', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 't', report: 'always' } });
    await store.saveJob(job);
    const config = {
      models: [{ name: 'qwen', provider: 'llama.cpp', gguf_path: '/models/qwen.gguf' }],
      active_model: 'qwen',
      jobs: { enabled: true, default_model: 'strata-flashnext-iq2xs' },
      llama_server: { binary: 'llama-server' },
    } as unknown as ForgeConfig;

    await new AgentTaskRunner(makeDeps({ defaultModel: () => jobDefaultModel(config) })).run(
      { job, state: JobStateSchema.parse({}) },
      false,
    );

    const runs = await store.readRuns('agent-task');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('failed');
    expect(runs[0]!.summary).toContain('was removed from config.yaml');
    expect(runs[0]!.summary).toContain('jobs.default_model');
    expect(runs[0]!.summary).not.toMatch(/unknown model/);
    expect(vi.mocked(host.send)).not.toHaveBeenCalled();
    expect(vi.mocked(host.setConversationModel)).not.toHaveBeenCalled();
    const item = await readOutboxItem(outboxDir, 'agent-task');
    expect(item!.text).toContain('jobs.default_model');
  });

  /**
   * A full chat cap used to be read as "that chat no longer exists": the runner
   * opened a silent second chat and rewrote `state.conversation_id`, so the run
   * reported ok while the job's discussion chat had been replaced underneath it.
   * The capacity refusal now fails the run with the message the user can act on,
   * and the stored id is left alone so the next run reopens the real chat.
   */
  it('records a failed run with the chat-cap message when the job chat cannot be reopened', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 't', report: 'always' } });
    await store.saveJob(job);
    store.patchState('agent-task', { conversation_id: 'conv-old' });
    host = {
      ...fakeHost([], { kind: 'completed', finalText: 'RESULT: ok' }),
      restoreConversation: vi
        .fn()
        .mockRejectedValue(new ChatCapacityError(['12 running a turn'], chatCapMessage(['12 running a turn']))),
    } as unknown as ForgeHostFacade;

    await new AgentTaskRunner(makeDeps()).run(
      { job, state: (await store.load('agent-task'))!.state },
      false,
    );

    const runs = await store.readRuns('agent-task');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('failed');
    expect(runs[0]!.summary).toContain('no open chat can be archived');
    expect(vi.mocked(host.createConversation)).not.toHaveBeenCalled();
    expect(vi.mocked(host.send)).not.toHaveBeenCalled();
    expect((await store.load('agent-task'))!.state.conversation_id).toBe('conv-old');
  });

  /**
   * A window that was never reloaded after an upgrade validates config.yaml with
   * last night's rules. The 2026-10-27 08:04 job failed on a config the
   * installed build accepted, and the morning report blamed the config; the
   * stale window was the cause anyone could act on. A failed run in that state
   * names it first, and an ok run does not mention it.
   */
  it('names the stale window before the symptom in a failed run', async () => {
    const job = baseJob({
      action: { kind: 'agent_task', task: 'switch the binary', report: 'always' },
    });
    await store.saveJob(job);
    const notice = 'Forge 0.17.87 is installed; this window still runs 0.17.86. Reload the window.';
    host = fakeHost([], { kind: 'failed', error: 'config.yaml validation failed' });

    await new AgentTaskRunner(makeDeps({ staleWindow: () => notice })).run(
      { job, state: JobStateSchema.parse({}) },
      false,
    );

    const runs = await store.readRuns('agent-task');
    const summary = runs[0]!.summary ?? '';
    expect(summary).toContain('Forge 0.17.87 is installed');
    expect(summary.indexOf('Forge 0.17.87')).toBeLessThan(summary.indexOf('validation failed'));
    const item = await readOutboxItem(outboxDir, 'agent-task');
    expect(item!.text).toContain('Reload the window');
  });

  it('leaves a successful run alone when the window is stale', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 't', report: 'always' } });
    await store.saveJob(job);
    const notice = 'Forge 0.17.87 is installed; this window still runs 0.17.86. Reload the window.';

    await new AgentTaskRunner(makeDeps({ staleWindow: () => notice })).run(
      { job, state: JobStateSchema.parse({}) },
      false,
    );

    const runs = await store.readRuns('agent-task');
    expect(runs[0]!.outcome).toBe('ok');
    expect(runs[0]!.summary).toContain('installed b1300');
    expect(runs[0]!.summary).not.toContain('0.17.87');
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

  it('defers instead of unloading a managed server another window is holding', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 't', model: 'qwen@main' } });
    await store.saveJob(job);
    pool = fakePool(['strata'], 1);
    const hold = {
      id: '4242-x',
      model: 'strata',
      pid: 4242,
      conversationId: 'chat-in-the-other-window',
      title: 'work chat',
      expiresAt: 0,
    };

    await new AgentTaskRunner(makeDeps({ externalTurnHolds: () => [hold] })).run(
      { job, state: JobStateSchema.parse({}) },
      false,
    );

    expect(host.unloadModels).not.toHaveBeenCalled();
    expect(host.send).not.toHaveBeenCalled();
    const state = (await store.load('agent-task'))!.state;
    expect(state.task_pending).toBe(true);
    expect(state.task_pending_reason).toContain("held for a turn by chat 'work chat'");

    // Bounded and visible, not silent starvation: a pending task older than one
    // schedule period is dropped with a `skipped` run row that names the chat
    // holding the server, so a hold a window leaked on purpose (BL-021 keeps an
    // expired record of a live process) ends by itself once that window closes.
    const ttlState = JobStateSchema.parse({
      task_pending: true,
      task_pending_since: Date.parse('2026-01-01T01:45:00'),
    });
    await new AgentTaskRunner(makeDeps({ externalTurnHolds: () => [hold] })).run(
      { job, state: ttlState },
      false,
    );
    const runs = await store.readRuns('agent-task');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('skipped');
    expect(runs[0]!.summary).toContain("held for a turn by chat 'work chat'");
    expect(host.send).not.toHaveBeenCalled();
  });

  it('defers when a hold turns up between admission and the unload', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 't', model: 'qwen@main' } });
    await store.saveJob(job);
    pool = fakePool(['strata'], 1);
    const hold = {
      id: '4242-x',
      model: 'strata',
      pid: 4242,
      conversationId: 'chat-in-the-other-window',
      title: 'work chat',
      expiresAt: 0,
    };
    // Empty at admission, taken by the other window before the unload gate.
    const holds = vi.fn().mockReturnValueOnce([]).mockReturnValueOnce([hold]);

    await new AgentTaskRunner(makeDeps({ externalTurnHolds: holds })).run(
      { job, state: JobStateSchema.parse({}) },
      false,
    );

    expect(holds).toHaveBeenCalledTimes(2);
    expect(host.unloadModels).not.toHaveBeenCalled();
    expect(host.send).not.toHaveBeenCalled();
    const lateState = (await store.load('agent-task'))!.state;
    expect(lateState.task_pending).toBe(true);
    expect(lateState.task_pending_reason).toContain("held for a turn by chat 'work chat'");
  });

  it('runs on a managed server another chat is holding: two chats share one server', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 't', model: 'strata' } });
    await store.saveJob(job);
    pool = fakePool(['strata'], 1);
    const hold = {
      id: '4242-x',
      model: 'strata',
      pid: 4242,
      conversationId: 'chat-in-the-other-window',
      title: 'work chat',
      expiresAt: 0,
    };

    await new AgentTaskRunner(makeDeps({ externalTurnHolds: () => [hold] })).run(
      { job, state: JobStateSchema.parse({}) },
      false,
    );

    expect(host.unloadModels).not.toHaveBeenCalled();
    expect(host.send).toHaveBeenCalledTimes(1);
  });

  it('joins a verified Strata slot without unloading its server from another window', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 't', model: 'strata' } });
    await store.saveJob(job);
    pool = fakePool(['other'], 1);
    const originalStatus = host.status;
    Object.assign(host, {
      status: () => ({
        ...originalStatus(),
        conversations: [
          {
            ...fakeConversation('active-user'),
            updatedAt: Date.parse('2026-01-01T02:59:59'),
          },
        ],
      }),
    });
    const probe = vi.fn(async () => [
      {
        index: 0,
        name: 'GPU',
        memoryUsedMb: 14742,
        memoryTotalMb: 16000,
        utilizationPercent: 95,
        temperatureC: 40,
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            service: 'strata',
            model: 'iq2_xs',
            loaded: true,
            concurrency: { serving: 2 },
            activity: { in_flight: 1 },
          }),
          { status: 200 },
        ),
      ),
    );
    try {
      const deps = makeDeps({
        gpuGate: {
          config: () => ({
            gpus: [0],
            max_util_percent: 25,
            max_idle_vram_mb: 2048,
            sample_seconds: 15,
          }),
          model: () => ({
            name: 'strata',
            provider: 'openai-compatible',
            endpoint: 'http://127.0.0.1:8092',
            model: 'iq2_xs',
            unload_path: '/unload',
          }),
          loadedModels: () => [],
          probe,
        },
      });
      await new AgentTaskRunner(deps).run({ job, state: JobStateSchema.parse({}) }, false);
      expect(host.unloadModels).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect((await store.readRuns('agent-task'))[0]!.outcome).toBe('ok');
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('a report the outbox could not take is recorded as not delivered (F-02)', async () => {
    const job = baseJob({ action: { kind: 'agent_task', task: 'install', report: 'always' } });
    await store.saveJob(job);
    // A file where the outbox folder should be: every outbox write fails.
    const blocked = path.join(jobsRoot, 'not-a-folder');
    await fs.promises.writeFile(blocked, '');
    await new AgentTaskRunner(makeDeps({ outboxDir: blocked })).run(
      { job, state: JobStateSchema.parse({}) },
      false,
    );
    const runs = await store.readRuns('agent-task');
    expect(runs[0]!.outcome).toBe('ok');
    expect(runs[0]!.delivered).toBe(0);
    // The local toast still went out; only the Telegram half was lost.
    expect(toasts.some((text) => text.startsWith('Job "'))).toBe(true);
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

  /**
   * The same script wording, end to end: `updated` used to be recorded as a
   * failed run — backoff, no observation saved, and a failure notice for work
   * that went well. It is now the ordinary success path.
   */
  it('an `updated` RESULT copied from the task script is a delivered success', async () => {
    const job = baseJob({
      action: { kind: 'agent_task', task: 'update', report: 'failures_and_changes' },
    });
    await store.saveJob(job);
    store.patchState('agent-task', { last_observation: '{"tag":"v1"}' });
    host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: updated - Maya v1 -> v2; engine rebuilt; not started',
    });

    const runner = new AgentTaskRunner(makeDeps());
    const saved = (await store.load('agent-task'))!.state;
    await runner.run({ job, state: { ...saved, last_observation: '{"tag":"v2"}' } }, false);

    const runs = await store.readRuns('agent-task');
    expect(runs[0]!.outcome).toBe('ok');
    expect(runs[0]!.changed).toBe(true);
    expect(runs[0]!.summary).toBe('Maya v1 -> v2; engine rebuilt; not started');
    expect((await store.load('agent-task'))!.state.last_observation).toBe('{"tag":"v2"}');
    expect(await readOutboxItem(outboxDir, 'agent-task')).toBeDefined();
  });

  /**
   * `RESULT: skipped` is the script saying "something outside me was busy" —
   * Maya running at the scheduled minute. Counting it as a failure made the job
   * back off and keep re-notifying a release it had never tried to install;
   * ignoring it silently would have left that update never attempted. So it is
   * reported, keeps the observation pending, and does not count against the job.
   */
  it('a `skipped` RESULT is reported, keeps the observation pending, is not a failure', async () => {
    const job = baseJob({
      action: { kind: 'agent_task', task: 'update', report: 'failures_and_changes' },
    });
    await store.saveJob(job);
    store.patchState('agent-task', { last_observation: '{"tag":"v1"}', consecutive_failures: 2 });
    host = fakeHost([], {
      kind: 'completed',
      finalText:
        'RESULT: skipped - Maya is running (python 4321); stop it and run the update again',
    });

    const runner = new AgentTaskRunner(makeDeps());
    const saved = (await store.load('agent-task'))!.state;
    await runner.run({ job, state: { ...saved, last_observation: '{"tag":"v2"}' } }, false);

    const state = (await store.load('agent-task'))!.state;
    const runs = await store.readRuns('agent-task');
    expect(runs[0]!.outcome).toBe('skipped');
    expect(runs[0]!.changed).toBe(false);
    expect(runs[0]!.summary).toBe(
      'Maya is running (python 4321); stop it and run the update again',
    );
    // Not a failure: no backoff, the counter resets, and last_ok_at stays unset.
    expect(state.consecutive_failures).toBe(0);
    expect(state.last_ok_at).toBeNull();
    // The release is still pending: the observation the run was handed is unsaved.
    expect(state.last_observation).toBe('{"tag":"v1"}');
    // And the owner is told, because only they can clear what blocked it.
    expect(await readOutboxItem(outboxDir, 'agent-task')).toBeDefined();
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
        body: JSON.stringify({ updated_at: '2026-01-01T03:00:00Z' }),
        etag: 'e1',
      })
      // No `comments` count on the issue, so the check makes no comments request.
      .mockResolvedValueOnce({
        body: JSON.stringify({ updated_at: '2026-01-01T03:15:00Z' }),
        etag: 'e2',
      })
      // What a 304 returns: the cached body, unchanged.
      .mockResolvedValue({
        body: JSON.stringify({ updated_at: '2026-01-01T03:15:00Z' }),
        etag: 'e2',
      });

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
        send: vi
          .fn()
          .mockImplementation(
            () => new Promise<ForgeRequestOutcome>((resolve) => (resolveSend = resolve)),
          ),
      } as unknown as ForgeHostFacade;
      nowMs += 1_000;
      await scheduler.tick();
      await vi.waitFor(() => expect(host.send).toHaveBeenCalledOnce());
      // Two issue fetches, both from the earlier ticks: the retry reruns no check.
      expect(jobsFetch).toHaveBeenCalledTimes(2);
      resolveSend({ kind: 'completed', finalText: 'RESULT: ok — retried' });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        runnerFinished,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('pending runner did not finish')), 1_000);
        }),
      ]).finally(() => clearTimeout(deadline));
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
      send: vi
        .fn()
        .mockImplementation(
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
    // The scheduler frees its running guard in a `.finally` on the runner's
    // promise, after the store already shows the run ended. Awaiting that same
    // promise resumes after the guard is freed, since the scheduler chained first.
    const runSpy = vi.spyOn(AgentTaskRunner.prototype, 'run');
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
      // The runner promise resolves only after finish() clears task_run and
      // appends the run row. Await that lifecycle boundary instead of relying
      // on vi.waitFor's short polling timeout under the full suite's load.
      await runSpy.mock.results[0]!.value;
      expect((await store.load('agent-task'))!.state.task_run).toBeNull();
      expect(await store.readRuns('agent-task')).toHaveLength(1);
      expect(runSpy).toHaveBeenCalledOnce();
      nowMs += 30_000;
      await scheduler.tick(); // the run ended: the request runs now
      expect(fs.existsSync(marker)).toBe(false);
      await vi.waitFor(() => expect(host.send).toHaveBeenCalledTimes(2));
      resolveSend({ kind: 'completed', finalText: 'RESULT: ok — done' });
      await vi.waitFor(async () => expect(await store.readRuns('agent-task')).toHaveLength(2));
    } finally {
      runSpy.mockRestore();
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

  it('refuses ask_user immediately inside a scheduled job turn', async () => {
    const job = baseJob();
    await store.saveJob(job);
    const questions = new UserQuestionService();
    const askUser = makeAskUserTool(questions);
    let refusal = '';
    host = {
      ...fakeHost([], { kind: 'completed', finalText: 'RESULT: ok — used a safe assumption' }),
      send: vi.fn(async (conversationId: string) => {
        refusal = (await askUser.handler(
          { prompt: 'Which option?' },
          { beforeMutate: () => undefined, conversationId },
        )) as string;
        return { kind: 'completed', finalText: 'RESULT: ok — used a safe assumption' };
      }),
    } as unknown as ForgeHostFacade;

    await new AgentTaskRunner(makeDeps()).run({ job, state: JobStateSchema.parse({}) }, false);

    const conversationId = (await store.load('agent-task'))!.state.conversation_id;
    expect(refusal).toContain('unattended: no user present');
    expect(questions.pendingConversationIds().size).toBe(0);
    expect(conversationId).not.toBeNull();
    expect(unattendedConversations.has(conversationId!)).toBe(false);
  });

  it('max_minutes cap cancels the turn and records a timeout', async () => {
    const job = baseJob({
      action: {
        kind: 'agent_task',
        task: 'install',
        max_minutes: 1,
        report: 'failures_and_changes',
      },
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
    const job = baseJob({
      action: {
        kind: 'agent_task',
        task: 'install',
        max_minutes: 1,
        report: 'failures_and_changes',
      },
    });
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
    const job = baseJob({
      action: {
        kind: 'agent_task',
        task: 'install',
        max_minutes: 1,
        report: 'failures_and_changes',
      },
    });
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
    await fs.promises.rm(jobsRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
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

// ── a job's chat: never silently replaced, never re-seeded ──────────────────

describe('job chat replacement and re-seeding', () => {
  let jobsRoot: string;
  let store: JobStore;

  beforeEach(async () => {
    jobsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-job-chat-'));
    store = new JobStore(jobsRoot);
  });

  afterEach(async () => {
    await fs.promises.rm(jobsRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  /** A host facade recording every restore, create and send; `restoreError` is
   *  what `restoreConversation` throws, because the two reasons differ: a stale
   *  id means a new chat, a full cap means the user has to free a tab. */
  function chatHost(restoreError?: Error) {
    const log = {
      restored: [] as Array<{ id: string; activate: boolean }>,
      created: 0,
      sent: [] as Array<{ id: string; text: string }>,
    };
    const host = {
      restoreConversation: vi.fn().mockImplementation(
        async (id: string, options?: { activate?: boolean }) => {
          log.restored.push({ id, activate: options?.activate === true });
          if (restoreError) throw restoreError;
          return fakeConversation(id);
        },
      ),
      createConversation: vi.fn().mockImplementation(async () => {
        log.created += 1;
        return fakeConversation('conv-new');
      }),
      send: vi.fn().mockImplementation(async (id: string, text: string) => {
        log.sent.push({ id, text });
        return { kind: 'completed', finalText: '' };
      }),
    } as unknown as ForgeHostFacade;
    return { host, log };
  }

  /** The job as it stands on disk, with `conversation_id` set to `chat`. */
  async function jobWithChat(chat: string | null): Promise<JobFile> {
    const job = baseJob();
    await store.saveJob(job);
    if (chat) store.patchState('agent-task', { conversation_id: chat });
    return { job, state: (await store.load('agent-task'))!.state };
  }

  it('refuses a full chat cap: no new chat, no state write, no seed', async () => {
    const jobFile = await jobWithChat('conv-old');
    const cap = new ChatCapacityError(['12 running a turn'], chatCapMessage(['12 running a turn']));
    const { host, log } = chatHost(cap);

    await expect(resolveJobConversation(host, store, jobFile, false)).rejects.toBeInstanceOf(
      ChatCapacityError,
    );
    await expect(openDiscussChat(host, store, jobFile, true)).rejects.toThrow(
      /no open chat can be archived/,
    );

    expect(log.created).toBe(0);
    expect(log.sent).toHaveLength(0);
    // The stored id is untouched, so the next open reuses the real chat.
    expect((await store.load('agent-task'))!.state.conversation_id).toBe('conv-old');
  });

  it('creates, seeds once and persists the id when the stored id no longer resolves', async () => {
    const jobFile = await jobWithChat('conv-gone');
    const { host, log } = chatHost(new Error('Forge: conversation could not be restored.'));

    const result = await openDiscussChat(host, store, jobFile, true);

    expect(result).toEqual({ conversationId: 'conv-new', created: true });
    expect(log.created).toBe(1);
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.id).toBe('conv-new');
    expect(log.sent[0]!.text).toContain('Job "Agent task" [agent-task]');
    expect((await store.load('agent-task'))!.state.conversation_id).toBe('conv-new');
  });

  it('creates and seeds a chat when no id is stored', async () => {
    const jobFile = await jobWithChat(null);
    const { host, log } = chatHost();

    const result = await openDiscussChat(host, store, jobFile, false);

    expect(result).toEqual({ conversationId: 'conv-new', created: true });
    expect(log.restored).toEqual([]);
    expect(log.sent).toHaveLength(1);
    expect((await store.load('agent-task'))!.state.conversation_id).toBe('conv-new');
  });

  it('reuses a restorable chat without seeding it again', async () => {
    const jobFile = await jobWithChat('conv-live');
    const { host, log } = chatHost();

    const result = await openDiscussChat(host, store, jobFile, true);

    expect(result).toEqual({ conversationId: 'conv-live', created: false });
    expect(log.created).toBe(0);
    expect(log.sent).toHaveLength(0);

    // A second open activates the same chat and still sends nothing: every
    // click on a job row used to start another model turn.
    await openDiscussChat(host, store, jobFile, false);
    expect(log.restored).toEqual([
      { id: 'conv-live', activate: true },
      { id: 'conv-live', activate: false },
    ]);
    expect(log.sent).toHaveLength(0);
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
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
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
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
    const out = await restartAfterTurn(
      { ...restartDeps(), host, pool: fakePool([], 1) },
      'qwen',
      ok,
    );
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
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
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
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
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
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
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
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    const out = await restartAfterTurn(
      { ...restartDeps(), host, backupPath, configPath, sleep },
      'qwen',
      ok,
    );
    // The cap hit counts as a failed restart. The first restart never settles,
    // so a second one would race it (U07-03): config is restored for the next
    // load and no rollback restart runs.
    expect(out.kind).toBe('failed');
    expect(out.sentence).toContain('its restart is still running');
    expect(out.sentence).toContain('config.yaml was rolled back to /old/binary');
    expect(host.restartModel).toHaveBeenCalledTimes(1);
    expect(await fs.promises.readFile(configPath, 'utf8')).toContain('/old/binary');
  });

  it('starts the rollback restart only after a timed-out restart settles (U07-03)', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const backupPath = path.join(dir, 'config.bak');
    const configPath = path.join(dir, 'config.yaml');
    await fs.promises.writeFile(backupPath, 'llama_server:\n  binary: /old/binary\n');
    await fs.promises.writeFile(configPath, 'llama_server:\n  binary: /new/binary\n');
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
    const order: string[] = [];
    let calls = 0;
    host.restartModel = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        // Finishes after the 50 ms cap but inside the settle window.
        await new Promise((resolve) => setTimeout(resolve, 80));
        order.push('first settled');
        return;
      }
      order.push('rollback started');
    });
    const sleep = (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms === RESTART_CAP_MS ? 50 : 500);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    const out = await restartAfterTurn(
      { ...restartDeps(), host, backupPath, configPath, sleep },
      'qwen',
      ok,
    );
    expect(order).toEqual(['first settled', 'rollback started']);
    expect(out.sentence).toContain('rolled back to /old/binary');
  });

  it('returns a failed outcome (never throws) when the first restart throws synchronously', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const backupPath = path.join(dir, 'config.bak');
    const configPath = path.join(dir, 'config.yaml');
    await fs.promises.writeFile(backupPath, 'llama_server:\n  binary: /old/binary\n');
    await fs.promises.writeFile(configPath, 'llama_server:\n  binary: /new/binary\n');
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
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
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            clearTimeout(t);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
    await restartAfterTurn({ ...restartDeps(), host, sleep }, 'qwen', ok);
    expect(host.restartModel).toHaveBeenCalledTimes(1);
    expect(aborted).toBe(true);
  });

  it('reports ok when the retry loads the new binary and there is no snapshot to roll back to', async () => {
    const ok = outcomeOf('RESULT: ok — installed b1234\nRESTART: yes');
    const configPath = path.join(dir, 'config.yaml');
    await fs.promises.writeFile(configPath, 'llama_server:\n  binary: /new/binary\n');
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
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
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
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
    const host = fakeHost([], {
      kind: 'completed',
      finalText: 'RESULT: ok — installed b1234\nRESTART: yes',
    });
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
