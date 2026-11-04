/**
 * `src/jobs/resumedRun.ts`: the reconciliation that turns a job card green when
 * the owner finishes a stopped run by hand in that job's own chat.
 *
 * The decision is pure, so every guard gets its own test rather than a table:
 * the whole point of each guard is a case the others cannot see (a different
 * chat, the job's own turn still running, an unattended marker still held, a
 * failure this turn cannot repair). The writer is tested against a real store in
 * a temp directory, because what it writes is exactly what the card reads back:
 * a row `RunRowSchema` accepts and a state patch that leaves the schedule alone.
 * The wrapper is tested with the conversation shape the sidebar hands it,
 * because `SendPipeline` is not edited here and cannot be driven from a test.
 *
 * Every unattended mark a test makes is disposed in the same test: the registry
 * is a module singleton, and a mark left behind would make the next test's
 * chat look like a job run.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANCELLED_TURN_ERROR, INTERRUPTED_TURN_ERROR } from '../../src/jobs/agentTaskReport';
import { JobStore, defaultState } from '../../src/jobs/JobStore';
import {
  RESUMED_RUN_NO_REPLY,
  RESUMED_RUN_SUMMARY_MAX_CHARS,
  RESUMED_RUN_SUMMARY_PREFIX,
  lastTurnStartAt,
  recordResumedRun,
  resumedRunDecision,
  resumedRunSummary,
  withResumedRunReconciliation,
  type ResumedRunDecision,
} from '../../src/jobs/resumedRun';
import {
  JobSchema,
  JobStateSchema,
  RunRowSchema,
  type Job,
  type JobFile,
  type JobState,
  type RunRow,
} from '../../src/jobs/jobSchema';
import type { RequestChainContext } from '../../src/sidebar/RequestChainLifecycle';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import type { ForgeTurnOutcome } from '../../src/sidebar/turnOutcome';
import type { ChatMessage } from '../../src/llm/types';
import { logger } from '../../src/util/logger';

const JOB_ID = 'weekly-bug-hunt';
const CHAT = 'conv-7c31d4';
/** The run the owner stopped, as its `failed` row records it. */
const STOPPED_AT = 1_700_000_000_000;
/** The owner's turn in the same chat, an hour later. */
const RESUME_AT = STOPPED_AT + 3_600_000;
/** When that turn ended: what the state patch stamps. */
const TURN_ENDED_AT = RESUME_AT + 5_400_000;
const PREVIOUS_OK = STOPPED_AT - 86_400_000;
const NEXT_DUE = STOPPED_AT + 86_400_000;
const OBSERVATION = 'llama.cpp-b1568';

/** A `task_run` as the schema takes it on input: only `started_at` is required. */
type TaskRun = { started_at: number; conversation_id?: string | null; heartbeat_at?: number | null };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the reconciled row and the state patch that follows it have both
 * landed. The row is written first and the patch is synchronous right after it.
 *
 * Only the runs file is polled fast. The state file is read once the row is
 * there, and then only every 250 ms: on Windows an open read blocks the atomic
 * rename `patchState` makes onto that file, and a 10 ms read loop under a loaded
 * `npm run ci` held it for the rename's whole 2.5 s retry budget, so the patch
 * failed (logged and swallowed) and the test waited on a write that never came.
 * Anything `recordResumedRun` logs is put in the failure message.
 */
const RECONCILE_WAIT_MS = 15_000;
async function waitForReconciliation(store: JobStore): Promise<void> {
  const logged: string[] = [];
  const spy = vi.spyOn(logger, 'error').mockImplementation((message: string) => {
    logged.push(message);
  });
  try {
    const deadline = Date.now() + RECONCILE_WAIT_MS;
    let rows = 0;
    let consecutive: number | undefined;
    for (;;) {
      rows = (await store.readRuns(JOB_ID)).length;
      if (rows >= 2) {
        consecutive = (await store.load(JOB_ID))?.state.consecutive_failures;
        if (consecutive === 0) return;
      }
      if (Date.now() > deadline || logged.length > 0) {
        throw new Error(
          `the reconciliation never landed: ${JSON.stringify({ rows, consecutive, logged })}`,
        );
      }
      await sleep(rows >= 2 ? 250 : 10);
    }
  } finally {
    spy.mockRestore();
  }
}

function job(overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    version: 1,
    id: JOB_ID,
    name: 'Weekly bug hunt',
    enabled: true,
    wake: false,
    after: 'stay_awake',
    schedule: { kind: 'daily', at: '22:00' },
    check: { kind: 'none' },
    on_change: { kind: 'notify' },
    action: { kind: 'agent_task', task: 'hunt bugs and fix them', report: 'always' },
    created_at: 100,
    updated_at: 0,
    ...overrides,
  });
}

/** The store's shape for a job whose last run the owner stopped: failing ×1. */
function stoppedJobFile(
  over: {
    conversationId?: string | null;
    taskRun?: TaskRun | null;
    consecutiveFailures?: number;
  } = {},
): JobFile {
  return {
    job: job(),
    state: JobStateSchema.parse({
      ...defaultState(),
      // `undefined` means "the chat this job owns"; an explicit `null` is the
      // case the guard exists for — a job whose owner has never opened its chat.
      conversation_id: over.conversationId === undefined ? CHAT : over.conversationId,
      consecutive_failures: over.consecutiveFailures ?? 1,
      last_ok_at: PREVIOUS_OK,
      last_run_at: STOPPED_AT,
      next_due_at: NEXT_DUE,
      last_observation: OBSERVATION,
      ...(over.taskRun === undefined ? {} : { task_run: over.taskRun }),
    }),
  };
}

/** The row a stopped turn leaves behind, with its error replaceable. */
function stoppedRow(over: Partial<RunRow> = {}): RunRow {
  return RunRowSchema.parse({
    at: STOPPED_AT,
    late: false,
    outcome: 'failed',
    changed: false,
    delivered: 1,
    summary: CANCELLED_TURN_ERROR,
    error: CANCELLED_TURN_ERROR,
    ...over,
  });
}

/** The call the sidebar makes: this chat, this turn start, this answer, this clock. */
function decide(
  file: JobFile,
  lastRow: RunRow | null,
  over: { conversationId?: string; turnStartedAt?: number; finalText?: string } = {},
): ResumedRunDecision | null {
  return resumedRunDecision(
    file,
    lastRow,
    over.conversationId ?? CHAT,
    over.turnStartedAt ?? RESUME_AT,
    over.finalText ?? 'RESULT: ok — 5 fixes shipped',
    TURN_ENDED_AT,
  );
}

function conversation(messages: ChatMessage[]): ConversationRuntime {
  return {
    id: CHAT,
    title: 'Job chat',
    createdAt: 0,
    updatedAt: 0,
    messages,
  } as unknown as ConversationRuntime;
}

const CHAIN = {
  conversationId: CHAT,
  userIntentEpoch: 0,
  autoContinueCount: 0,
  reservation: {},
} as unknown as RequestChainContext;

const CONTINUE = { kind: 'continue' as const, text: 'keep going' };

/** A policy that records what it was asked for and answers with a continuation. */
function recordingPolicy(calls: { convId: string; chain: RequestChainContext }[]) {
  return {
    async evaluateAfterTurn(conv: ConversationRuntime, chain: RequestChainContext) {
      calls.push({ convId: conv.id, chain });
      return CONTINUE;
    },
  };
}

/** A store whose listing throws, standing in for an unreadable jobs directory. */
class BrokenStore extends JobStore {
  override async loadAll(): Promise<JobFile[]> {
    throw new Error('EACCES: permission denied');
  }
}

/** A store whose job vanishes between the listing and the write (deleted elsewhere). */
class GoneBeforeWriteStore extends JobStore {
  override async load(id: string): Promise<JobFile | undefined> {
    await super.load(id);
    return undefined;
  }
}

/**
 * A store that lets the scheduler write a newer row between our read of the
 * run log and our write of the reconciled one: the decision is re-run against
 * that newer last row, so nothing lands out of order.
 */
class RowAppearingStore extends JobStore {
  private reads = 0;
  override async readRuns(id: string): Promise<RunRow[]> {
    this.reads += 1;
    if (this.reads === 2) {
      await super.appendRun(id, {
        at: RESUME_AT + 120_000,
        outcome: 'ok',
        summary: 'the scheduler ran it again',
        delivered: 0,
      });
    }
    return super.readRuns(id);
  }
}

/** A store that lists jobs but cannot read their run logs. */
class NoRunLogStore extends JobStore {
  override async readRuns(id: string): Promise<RunRow[]> {
    await super.readRuns(id);
    throw new Error('EACCES: permission denied');
  }
}

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-resumed-run-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A real store holding exactly what the defect's job holds: one stopped run. */
async function storeWithStoppedRun(error: string = CANCELLED_TURN_ERROR): Promise<JobStore> {
  const fresh = new JobStore(root);
  await fresh.saveJob(job());
  fresh.patchState(JOB_ID, {
    conversation_id: CHAT,
    consecutive_failures: 1,
    last_ok_at: PREVIOUS_OK,
    last_run_at: STOPPED_AT,
    next_due_at: NEXT_DUE,
    last_observation: OBSERVATION,
  });
  await fresh.appendRun(JOB_ID, stoppedRow({ error, summary: error }));
  return fresh;
}

describe('resumedRunDecision — when a completed turn closes a stopped run', () => {
  it('closes a run whose row says the turn was cancelled', () => {
    const decision = decide(stoppedJobFile(), stoppedRow());
    expect(decision).not.toBeNull();
    expect(decision!.row).toEqual({
      at: RESUME_AT,
      late: false,
      outcome: 'ok',
      changed: true,
      summary: `${RESUMED_RUN_SUMMARY_PREFIX}RESULT: ok — 5 fixes shipped`,
      delivered: 0,
      resumed: true,
    });
  });

  it('closes a run whose row says the turn was interrupted', () => {
    const decision = decide(
      stoppedJobFile(),
      stoppedRow({ error: INTERRUPTED_TURN_ERROR, summary: INTERRUPTED_TURN_ERROR }),
    );
    expect(decision!.row.outcome).toBe('ok');
    expect(decision!.row.resumed).toBe(true);
  });

  it('writes nothing for a chat this job does not own', () => {
    expect(decide(stoppedJobFile(), stoppedRow(), { conversationId: 'conv-some-other-chat' })).toBeNull();
    expect(decide(stoppedJobFile({ conversationId: null }), stoppedRow())).toBeNull();
    expect(decide(stoppedJobFile({ conversationId: 'conv-the-previous-chat' }), stoppedRow())).toBeNull();
  });

  it('writes nothing while the job has a run in flight: that chat is a job turn', () => {
    const running = stoppedJobFile({
      taskRun: { started_at: RESUME_AT, conversation_id: CHAT, heartbeat_at: RESUME_AT },
    });
    expect(decide(running, stoppedRow())).toBeNull();
    // A stale heartbeat is still a run in flight: the owner cannot have closed it.
    expect(
      decide(stoppedJobFile({ taskRun: { started_at: STOPPED_AT, heartbeat_at: STOPPED_AT } }), stoppedRow()),
    ).toBeNull();
  });

  it('writes nothing while the chat is unattended, the runner’s own marker', () => {
    const marker = unattendedConversations.mark(CHAT, { jobId: JOB_ID, jobName: 'Weekly bug hunt' });
    try {
      expect(decide(stoppedJobFile(), stoppedRow())).toBeNull();
    } finally {
      marker.dispose();
    }
  });

  it('writes nothing when the last row is not a failure', () => {
    expect(decide(stoppedJobFile(), stoppedRow({ outcome: 'ok', error: undefined }))).toBeNull();
    expect(decide(stoppedJobFile(), stoppedRow({ outcome: 'skipped', error: undefined }))).toBeNull();
    expect(decide(stoppedJobFile(), null)).toBeNull(); // a job that has never run
  });

  it('writes nothing for a failure the owner’s turn cannot repair', () => {
    // The cap, not a stop: the schedule already backed off and the card is right.
    expect(
      decide(
        stoppedJobFile(),
        stoppedRow({ error: 'timed out after the max_minutes cap', summary: 'timed out after the max_minutes cap' }),
      ),
    ).toBeNull();
    // A stale-build window prefixes the same sentence, and the match is exact:
    // that row names a cause the owner has to act on, so it stays red.
    expect(
      decide(stoppedJobFile(), stoppedRow({ error: `stale-build ${CANCELLED_TURN_ERROR}` })),
    ).toBeNull();
    expect(decide(stoppedJobFile(), stoppedRow({ error: 'unknown error' }))).toBeNull();
  });

  it('writes nothing when the turn did not start after the stopped row', () => {
    expect(decide(stoppedJobFile(), stoppedRow(), { turnStartedAt: STOPPED_AT })).toBeNull();
    expect(decide(stoppedJobFile(), stoppedRow(), { turnStartedAt: STOPPED_AT - 1 })).toBeNull();
  });

  it('patches exactly three fields, so the schedule and observation stay where they are', () => {
    const decision = decide(stoppedJobFile(), stoppedRow())!;
    expect(Object.keys(decision.patch).sort()).toEqual([
      'consecutive_failures',
      'last_ok_at',
      'last_run_at',
    ]);
    expect(decision.patch).toEqual({
      consecutive_failures: 0,
      last_ok_at: TURN_ENDED_AT,
      last_run_at: TURN_ENDED_AT,
    });
  });

  it('summarises the first line of the answer only, trimmed, or the no-reply text', () => {
    const long = 'x'.repeat(400);
    expect(resumedRunSummary(`${long}\nRESULT: ok — done`)).toBe(
      RESUMED_RUN_SUMMARY_PREFIX + `${'x'.repeat(RESUMED_RUN_SUMMARY_MAX_CHARS - 1)}…`,
    );
    expect(resumedRunSummary('   \n\n  second line  \nthird')).toBe(
      `${RESUMED_RUN_SUMMARY_PREFIX}second line`,
    );
    expect(resumedRunSummary('')).toBe(`${RESUMED_RUN_SUMMARY_PREFIX}${RESUMED_RUN_NO_REPLY}`);
    expect(resumedRunSummary('   ')).toBe(`${RESUMED_RUN_SUMMARY_PREFIX}${RESUMED_RUN_NO_REPLY}`);
  });
});

describe('recordResumedRun — what it writes', () => {
  it('appends an ok row the schema accepts and turns the state green', async () => {
    const store = await storeWithStoppedRun();
    await recordResumedRun(store, CHAT, RESUME_AT, 'RESULT: ok — 5 fixes shipped\nmore detail', TURN_ENDED_AT);

    const raw = (
      await fs.promises.readFile(path.join(root, 'runs', `${JOB_ID}.jsonl`), 'utf8')
    ).trim().split('\n');
    const written = RunRowSchema.parse(JSON.parse(raw[raw.length - 1]!));
    expect(written).toMatchObject({
      at: RESUME_AT,
      outcome: 'ok',
      changed: true,
      delivered: 0,
      resumed: true,
      summary: `${RESUMED_RUN_SUMMARY_PREFIX}RESULT: ok — 5 fixes shipped`,
    });
    expect(await store.readRuns(JOB_ID)).toHaveLength(2);

    const state = (await store.load(JOB_ID))!.state;
    expect(state.consecutive_failures).toBe(0);
    expect(state.last_ok_at).toBe(TURN_ENDED_AT);
    expect(state.last_run_at).toBe(TURN_ENDED_AT);
    // The two the plan says to leave alone, checked as they were left.
    expect(state.next_due_at).toBe(NEXT_DUE);
    expect(state.last_observation).toBe(OBSERVATION);
    expect(state.task_run).toBeNull();
    expect(state.conversation_id).toBe(CHAT);
  });

  it('a second completed turn after the write matches nothing, so nothing is doubled', async () => {
    const store = await storeWithStoppedRun();
    await recordResumedRun(store, CHAT, RESUME_AT, 'first answer', TURN_ENDED_AT);
    const afterFirst = await store.readRuns(JOB_ID);
    await recordResumedRun(store, CHAT, RESUME_AT + 60_000, 'second answer', TURN_ENDED_AT + 60_000);
    expect(await store.readRuns(JOB_ID)).toHaveLength(afterFirst.length);
    expect((await store.load(JOB_ID))!.state.last_run_at).toBe(TURN_ENDED_AT);
  });

  it('leaves a timeout red, and leaves the failure count where it was', async () => {
    const store = await storeWithStoppedRun('timed out after the max_minutes cap');
    await recordResumedRun(store, CHAT, RESUME_AT, 'RESULT: ok — done', TURN_ENDED_AT);
    expect(await store.readRuns(JOB_ID)).toHaveLength(1);
    const state = (await store.load(JOB_ID))!.state;
    expect(state.consecutive_failures).toBe(1);
    expect(state.last_ok_at).toBe(PREVIOUS_OK);
  });

  it('writes nothing for a chat that belongs to no job', async () => {
    const store = await storeWithStoppedRun();
    await recordResumedRun(store, 'conv-a-plain-chat', RESUME_AT, 'RESULT: ok', TURN_ENDED_AT);
    expect(await store.readRuns(JOB_ID)).toHaveLength(1);
    expect((await store.load(JOB_ID))!.state.consecutive_failures).toBe(1);
  });

  it('a completed turn in the job’s own unattended chat is not the owner', async () => {
    const store = await storeWithStoppedRun();
    const marker = unattendedConversations.mark(CHAT, { jobId: JOB_ID, jobName: 'Weekly bug hunt' });
    try {
      await recordResumedRun(store, CHAT, RESUME_AT, 'RESULT: ok — done', TURN_ENDED_AT);
    } finally {
      marker.dispose();
    }
    expect(await store.readRuns(JOB_ID)).toHaveLength(1);
    expect((await store.load(JOB_ID))!.state.consecutive_failures).toBe(1);
  });

  it('writes nothing when the job is deleted between the listing and the write', async () => {
    const store = new GoneBeforeWriteStore(root);
    await store.saveJob(job());
    store.patchState(JOB_ID, { conversation_id: CHAT, consecutive_failures: 1 });
    await store.appendRun(JOB_ID, stoppedRow());
    const stateBefore = await fs.promises.readFile(path.join(root, 'state', `${JOB_ID}.json`), 'utf8');

    await recordResumedRun(store, CHAT, RESUME_AT, 'RESULT: ok', TURN_ENDED_AT);
    expect(await store.readRuns(JOB_ID)).toHaveLength(1);
    expect(await fs.promises.readFile(path.join(root, 'state', `${JOB_ID}.json`), 'utf8')).toBe(stateBefore);
  });

  it('writes nothing when a newer row lands in the meantime, so the log stays ordered', async () => {
    const store = new RowAppearingStore(root);
    await store.saveJob(job());
    store.patchState(JOB_ID, { conversation_id: CHAT, consecutive_failures: 1 });
    await store.appendRun(JOB_ID, stoppedRow());

    await recordResumedRun(store, CHAT, RESUME_AT, 'RESULT: ok', TURN_ENDED_AT);
    const rows = await store.readRuns(JOB_ID);
    expect(rows.map((row) => row.summary)).toEqual([CANCELLED_TURN_ERROR, 'the scheduler ran it again']);
    expect((await store.load(JOB_ID))!.state.consecutive_failures).toBe(1);
  });

  it('a store it cannot read is logged with the chat, and with the job once known', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(logger, 'error').mockImplementation((message: string) => {
      errors.push(message);
    });
    // A listing that works and a run log that does not: by then the job id is
    // known, so the line names the job the owner has to look at.
    const store = new NoRunLogStore(root);
    await store.saveJob(job());
    store.patchState(JOB_ID, { conversation_id: CHAT });
    await expect(recordResumedRun(store, CHAT, RESUME_AT, 'RESULT: ok')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(errors[0]).toContain(CHAT);
    expect(errors[0]).toContain(JOB_ID);
    expect(errors[0]).toContain('permission denied');

    // A store that cannot even be listed says the same thing, with no job to name.
    errors.length = 0;
    await expect(
      recordResumedRun(new BrokenStore(root), CHAT, RESUME_AT, 'RESULT: ok'),
    ).resolves.toBeUndefined();
    expect(errors[0]).toContain(CHAT);
    expect(errors[0]).not.toContain(JOB_ID);
  });
});

describe('withResumedRunReconciliation — the post-turn wiring', () => {
  it('a completed turn closes the run stopped in that chat and still runs the policy', async () => {
    const store = await storeWithStoppedRun();
    const calls: { convId: string; chain: RequestChainContext }[] = [];
    const wrapped = withResumedRunReconciliation(recordingPolicy(calls), store);
    const turn: ForgeTurnOutcome = {
      kind: 'completed',
      finalText: 'RESULT: ok — 5 fixes shipped',
      finishReason: 'stop',
    };

    const action = await wrapped(
      conversation([
        { role: 'user', content: 'Resume', createdAt: RESUME_AT },
        { role: 'assistant', content: 'RESULT: ok — 5 fixes shipped' },
      ]),
      CHAIN,
      turn,
    );
    expect(action).toBe(CONTINUE);
    expect(calls).toEqual([{ convId: CHAT, chain: CHAIN }]);
    await waitForReconciliation(store);
    const rows = await store.readRuns(JOB_ID);
    expect(rows[1]).toMatchObject({ at: RESUME_AT, outcome: 'ok', resumed: true });
    expect((await store.load(JOB_ID))!.state.consecutive_failures).toBe(0);
  }, RECONCILE_WAIT_MS + 5_000);

  it('a turn that did not complete writes nothing and still reaches the policy', async () => {
    const store = await storeWithStoppedRun();
    const calls: { convId: string; chain: RequestChainContext }[] = [];
    const wrapped = withResumedRunReconciliation(recordingPolicy(calls), store);
    const action = await wrapped(conversation([{ role: 'user', content: 'go', createdAt: RESUME_AT }]), CHAIN, {
      kind: 'cancelled',
      finalText: '',
    });
    expect(action).toBe(CONTINUE);
    expect(calls).toHaveLength(1);
    expect(await store.readRuns(JOB_ID)).toHaveLength(1);
  });

  it('the job’s own completed turn is refused by the guards, not by a check here', async () => {
    const store = await storeWithStoppedRun();
    // Exactly the state the runner holds while `SendPipeline`'s hook is running:
    // `task_run` still set and the unattended marker not yet disposed.
    store.patchState(JOB_ID, { task_run: { started_at: RESUME_AT, conversation_id: CHAT, heartbeat_at: RESUME_AT } });
    const marker = unattendedConversations.mark(CHAT, { jobId: JOB_ID, jobName: 'Weekly bug hunt' });
    const calls: { convId: string; chain: RequestChainContext }[] = [];
    const wrapped = withResumedRunReconciliation(recordingPolicy(calls), store);
    try {
      await wrapped(conversation([{ role: 'user', content: 'the job prompt', createdAt: RESUME_AT }]), CHAIN, {
        kind: 'completed',
        finalText: 'RESULT: ok — done',
        finishReason: 'stop',
      });
      await sleep(50);
    } finally {
      marker.dispose();
    }
    expect(calls).toHaveLength(1);
    expect(await store.readRuns(JOB_ID)).toHaveLength(1);
  });

  it('a store read failure does not reach the turn, and the policy still answers', async () => {
    const calls: { convId: string; chain: RequestChainContext }[] = [];
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const wrapped = withResumedRunReconciliation(recordingPolicy(calls), new BrokenStore(root));
    const action = await wrapped(conversation([{ role: 'user', content: 'go', createdAt: RESUME_AT }]), CHAIN, {
      kind: 'completed',
      finalText: 'RESULT: ok',
      finishReason: 'stop',
    });
    expect(action).toBe(CONTINUE);
    expect(calls).toHaveLength(1);
    // The reconciliation is fire-and-forget: give its failed read time to land,
    // then check it was logged rather than thrown into the turn.
    await sleep(50);
    expect(spy).toHaveBeenCalled();
  });
});

describe('lastTurnStartAt — where the turn’s start comes from', () => {
  it('reads the prompt the turn began with, not the messages after it', () => {
    expect(
      lastTurnStartAt(
        conversation([
          { role: 'user', content: 'earlier', createdAt: RESUME_AT - 7_200_000 },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'Resume', createdAt: RESUME_AT },
          { role: 'assistant', content: 'RESULT: ok' },
        ]),
      ),
    ).toBe(RESUME_AT);
  });

  it('falls back to now for a prompt with no stamp, which is still after the stopped row', () => {
    const before = Date.now();
    const start = lastTurnStartAt(conversation([{ role: 'user', content: 'Resume' }]));
    const after = Date.now();
    expect(start).toBeGreaterThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(after);
    expect(start).toBeGreaterThan(STOPPED_AT);
    expect(lastTurnStartAt(conversation([]))).toBeGreaterThan(STOPPED_AT);
  });
});
