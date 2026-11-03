/**
 * The daily retitle job (`docs/plans/NEXT_WEEK_PROPOSALS_2026_10_24_PLAN.md`
 * idea 1, decided in `docs/plans/V1_FINISH_PLAN.md` lane 4 phase 4.2).
 *
 * Two halves, both asserted here:
 *
 * - the filter (`src/jobs/retitleCandidates.ts`), which is the whole safety of
 *   the feature: a chat a person named, or a chat the job already named, is
 *   never renamed again, and a chat the owner may be in is never touched.
 *   Records written before `title_source` existed are exercised explicitly,
 *   because most of the chats this job will meet are those.
 * - the runner (`src/jobs/retitleRun.ts`), against a real `JobStore` in a temp
 *   folder and a temp workspace storage folder, so the batch limit, the dry
 *   run, the deferral when the GPU is busy, and the state the run writes are
 *   checked as data, not as mocks.
 *
 * No model and no VS Code run here: `summarize` is a fake that returns a
 * string, exactly as `on_change: summarize` already does in production.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobStore } from '../../src/jobs/JobStore';
import { JobScheduler } from '../../src/jobs/JobScheduler';
import { PowerControl } from '../../src/system/PowerControl';
import { JobSchema, JobStateSchema, type JobFile } from '../../src/jobs/jobSchema';
import { RetitleRunner, type RetitleDeps } from '../../src/jobs/retitleRun';
import { readRetitleRecords } from '../../src/jobs/retitleRecords';
import {
  JOB_TASK_PROMPT_MARKER,
  buildRetitleRequest,
  parseProposedTitle,
  pickRetitleCandidates,
  retitleSkipReason,
  type RetitleConversation,
} from '../../src/jobs/retitleCandidates';
import { deriveTitle, titleSourceOf, UNTITLED_TITLE } from '../../src/sidebar/conversationTitle';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const DAY_MS = 86_400_000;
const now = 1_700_000_000_000;
const prompt = 'Fix the tractor beam so it pulls the pods';

function record(over: Partial<RetitleConversation> = {}): RetitleConversation {
  return {
    id: 'chat-old',
    title: deriveTitle(prompt),
    firstUserLine: prompt,
    updatedAt: now - 30 * DAY_MS,
    open: false,
    ...over,
  };
}

const options = {
  now,
  minIdleMs: 60 * 60_000,
  limit: 20,
  jobConversationIds: new Set<string>(),
};

describe('the candidate filter', () => {
  it('offers a chat still carrying the name its first prompt gave it', () => {
    expect(retitleSkipReason(record(), options)).toBe('ok');
    // The legacy case: no `title_source` field at all, decided from the line.
    expect(titleSourceOf({ title: deriveTitle(prompt) }, prompt)).toBe('prompt');
    expect(pickRetitleCandidates([record()], options)).toHaveLength(1);
  });

  it('leaves a chat whose title is not the derived one alone', () => {
    expect(retitleSkipReason(record({ title: 'Tractor beam work' }), options)).toBe(
      'named-by-a-person',
    );
    expect(titleSourceOf({ title: 'Tractor beam work' }, prompt)).toBe('user');
  });

  it('leaves a chat the job already named alone, so a run cannot loop', () => {
    expect(retitleSkipReason(record({ titleSource: 'auto' }), options)).toBe('already-auto-named');
  });

  it('leaves a chat a person renamed alone', () => {
    expect(retitleSkipReason(record({ titleSource: 'user' }), options)).toBe('named-by-a-person');
  });

  it('treats an untitled placeholder as still needing a name', () => {
    expect(
      retitleSkipReason(record({ title: UNTITLED_TITLE, firstUserLine: prompt }), options),
    ).toBe('ok');
  });

  it('skips a job chat by its live id and by its first line', () => {
    // `JobStore.delete` drops the id with the job, so the marker is the durable
    // half: a deleted job leaves its chat behind, named for its task.
    expect(
      retitleSkipReason(record(), {
        ...options,
        jobConversationIds: new Set(['chat-old']),
      }),
    ).toBe('job-chat');
    expect(
      retitleSkipReason(
        record({ firstUserLine: `${JOB_TASK_PROMPT_MARKER}Basalt watch":` }),
        options,
      ),
    ).toBe('job-chat');
  });

  it('skips a chat that is open, streaming, or too recent', () => {
    expect(retitleSkipReason(record({ open: true }), options)).toBe('open-or-streaming');
    expect(retitleSkipReason(record({ streaming: true }), options)).toBe('open-or-streaming');
    expect(retitleSkipReason(record({ updatedAt: now - 10 * 60_000 }), options)).toBe('too-recent');
  });

  it('skips a chat with nothing to name it from', () => {
    // A placeholder with no first line to ask about: naming it would mean
    // inventing a subject, which is worse than the placeholder it has.
    expect(retitleSkipReason(record({ title: UNTITLED_TITLE, firstUserLine: '' }), options)).toBe(
      'nothing-to-name-it-from',
    );
    expect(
      retitleSkipReason(record({ title: UNTITLED_TITLE, firstUserLine: undefined }), options),
    ).toBe('nothing-to-name-it-from');
  });

  it('caps the run at the limit and takes the oldest chats first', () => {
    const records = [
      record({ id: 'new', updatedAt: now - 5 * DAY_MS }),
      record({ id: 'old', updatedAt: now - 90 * DAY_MS }),
      record({ id: 'middle', updatedAt: now - 30 * DAY_MS }),
    ];
    const picked = pickRetitleCandidates(records, { ...options, limit: 2 });
    expect(picked.map((c) => c.id)).toEqual(['old', 'middle']);
  });

  it('names the current title and the two lines it is asked from', () => {
    const request = buildRetitleRequest({
      id: 'x',
      title: deriveTitle(prompt),
      firstUserLine: prompt,
      lastAssistantLine: 'The pitch was never wired to a key.',
      updatedAt: now,
    });
    expect(request).toContain(prompt);
    expect(request).toContain('The pitch was never wired to a key.');
    expect(request).toContain('Reply with ONLY the new name');
  });
});

describe('what the model sent back', () => {
  it('accepts a plain name and strips quotes', () => {
    expect(parseProposedTitle('"Orbital salvage pitch controls"\n', 48)).toBe(
      'Orbital salvage pitch controls',
    );
  });

  it('refuses a sentence, a long answer, and a placeholder', () => {
    expect(parseProposedTitle('It was about the tractor beam.', 48)).toBeUndefined();
    expect(parseProposedTitle('a'.repeat(60), 48)).toBeUndefined();
    expect(parseProposedTitle(UNTITLED_TITLE, 48)).toBeUndefined();
    expect(parseProposedTitle('   \n  ', 48)).toBeUndefined();
  });
});

// ── The runner ───────────────────────────────────────────────────────────────

let storage: string;
let logs: string;
let jobsRoot: string;
let store: JobStore;

function writeBody(dir: string, id: string, title: string, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(storage, dir), { recursive: true });
  fs.writeFileSync(
    path.join(storage, dir, `${id}.json`),
    JSON.stringify({
      id,
      title,
      createdAt: now - 40 * DAY_MS,
      updatedAt: now - 30 * DAY_MS,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: 'Here is the fix for the beam.' },
      ],
      ...extra,
    }),
  );
}

beforeEach(async () => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-retitle-ws-'));
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-retitle-logs-'));
  jobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-retitle-jobs-'));
  store = new JobStore(jobsRoot);
  await store.ensureDirs();
  // Open chat: named from its prompt, but the window may be using it.
  writeBody('open', 'open-chat', deriveTitle(prompt));
  // Closed chats: one still prompt-named, one renamed by the owner.
  writeBody('history', 'prompt-named', deriveTitle(prompt));
  writeBody('history', 'owner-named', 'Tractor beam work');
  // An archive row whose body is the session log: the cheap half of the store.
  fs.mkdirSync(path.join(storage, 'archive'), { recursive: true });
  fs.writeFileSync(
    path.join(storage, 'archive', 'index.json'),
    JSON.stringify([
      {
        id: 'log-named',
        title: deriveTitle(prompt),
        createdAt: now - 40 * DAY_MS,
        updatedAt: now - 20 * DAY_MS,
        messageCount: 2,
        source: 'log',
      },
    ]),
  );
  fs.writeFileSync(
    path.join(logs, 'log-named.jsonl'),
    [
      JSON.stringify({ type: 'session_start', title: UNTITLED_TITLE, timestamp_ms: 1 }),
      JSON.stringify({ role: 'user', content: prompt, timestamp_ms: 2 }),
      JSON.stringify({ role: 'assistant', content: 'Beam fixed.', timestamp_ms: 3 }),
    ].join('\n'),
  );
});

afterEach(() => {
  for (const dir of [storage, logs, jobsRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

function jobFile(over: Record<string, unknown> = {}): JobFile {
  const job = JobSchema.parse({
    version: 1,
    id: 'retitle-daily',
    name: 'Retitle old chats',
    schedule: { kind: 'daily', at: '04:00' },
    check: { kind: 'none' },
    on_change: { kind: 'notify' },
    action: { kind: 'retitle', max_chats: 2, dry_run: false, ...over },
    created_at: 0,
    updated_at: 0,
  });
  return { job, state: JobStateSchema.parse({}) };
}

/**
 * The job as the runner sees it: saved first, because a run that finds its job
 * gone from the store stops without writing anything (a job deleted while its
 * pass was in flight), and that behaviour is only worth asserting once the job
 * really exists. `store.load` is the check the runner uses, so the saved copy
 * is also the one whose state it patches.
 */
async function savedJobFile(over: Record<string, unknown> = {}): Promise<JobFile> {
  const file = jobFile(over);
  await store.saveJob(file.job);
  return file;
}

function fakeHost(applied: Array<[string, string]>): ForgeHostFacade {
  return {
    status: () => ({
      activeConversationId: 'open-chat',
      conversations: [],
      requestChains: [],
      streamingConversationIds: [],
    }),
    applyAutoTitle: (conversationId: string, title: string) => {
      applied.push([conversationId, title]);
      return true;
    },
  } as unknown as ForgeHostFacade;
}

function deps(over: Partial<RetitleDeps> = {}): RetitleDeps {
  const applied: Array<[string, string]> = [];
  return {
    store,
    host: () => fakeHost(applied),
    dirs: () => ({ storageDir: storage, logsDirectory: logs }),
    summarize: async () => 'Orbital salvage beam fix',
    defaultModel: () => 'strata',
    outboxDir: store.outboxDir,
    notifyLocal: () => undefined,
    busy: () => undefined,
    now: () => Date.now(),
    ...over,
  };
}

describe('RetitleRunner', () => {
  it('applies a title to each chat the filter offered, and to no other', async () => {
    const applied: Array<[string, string]> = [];
    const runner = new RetitleRunner({
      ...deps(),
      host: () => fakeHost(applied),
    });
    await runner.run(await savedJobFile({ max_chats: 20 }), false);
    const ids = applied.map(([id]) => id).sort();
    // `open-chat` is open, `owner-named` has a title that is not the derived
    // one, so only the two prompt-named closed chats are offered.
    expect(ids).toEqual(['log-named', 'prompt-named']);
    expect(applied.every(([, title]) => title === 'Orbital salvage beam fix')).toBe(true);
    const runs = await store.readRuns('retitle-daily');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe('ok');
    expect(runs[0]?.summary).toContain('gave 2 of 2 chats');
    const state = (await store.load('retitle-daily'))!.state;
    expect(state.last_ok_at).toBeTruthy();
    expect(state.next_due_at).toBeTruthy();
    expect(state.consecutive_failures).toBe(0);
  });

  it('renames at most the batch limit', async () => {
    const applied: Array<[string, string]> = [];
    await new RetitleRunner({ ...deps(), host: () => fakeHost(applied) }).run(
      await savedJobFile({ max_chats: 1 }),
      false,
    );
    expect(applied).toHaveLength(1);
  });

  it('a dry run lists what it would do and writes no title', async () => {
    const applied: Array<[string, string]> = [];
    await new RetitleRunner({ ...deps(), host: () => fakeHost(applied) }).run(
      await savedJobFile({ dry_run: true }),
      false,
    );
    expect(applied).toEqual([]);
    const runs = await store.readRuns('retitle-daily');
    expect(runs[0]?.summary).toContain('dry run');
    expect(runs[0]?.summary).toContain('would be retitled');
  });

  it('waits instead of running while a turn is streaming', async () => {
    const summarize = vi.fn(async () => 'x');
    const applied: Array<[string, string]> = [];
    await new RetitleRunner({
      ...deps(),
      host: () => fakeHost(applied),
      busy: () => 'a turn is streaming',
      summarize,
    }).run(await savedJobFile(), false);
    expect(summarize).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
    const state = (await store.load('retitle-daily'))!.state;
    expect(state.task_pending).toBe(true);
    expect(state.task_pending_reason).toContain('streaming');
    expect(await store.readRuns('retitle-daily')).toHaveLength(0);
  });

  it('a chat streaming when its title is about to be applied is left alone', async () => {
    const applied: Array<[string, string]> = [];
    // The scan sees an idle window; by the time the first title comes back, the
    // owner has opened that chat. `status()` is read once for the scan and once
    // again before each write, so the second read onward reports it streaming.
    let statusReads = 0;
    const runner = new RetitleRunner({
      ...deps(),
      host: () =>
        ({
          status: () => {
            statusReads += 1;
            return {
              activeConversationId: 'x',
              conversations: [],
              requestChains: [],
              streamingConversationIds: statusReads > 1 ? ['prompt-named'] : [],
            };
          },
          applyAutoTitle: (id: string, title: string) => {
            applied.push([id, title]);
            return true;
          },
        }) as unknown as ForgeHostFacade,
    });
    await runner.run(await savedJobFile({ max_chats: 20 }), false);
    expect(applied.map(([id]) => id)).toEqual(['log-named']);
  });

  it('a workspace with no conversation stores runs clean and reports nothing to do', async () => {
    const missing = path.join(storage, 'not-here');
    await new RetitleRunner({
      ...deps(),
      dirs: () => ({ storageDir: missing, logsDirectory: logs }),
    }).run(await savedJobFile(), false);
    const runs = await store.readRuns('retitle-daily');
    expect(runs[0]?.outcome).toBe('ok');
    expect(runs[0]?.summary).toContain('0 of 0');
  });

  it('reads the store as the filter expects it', () => {
    const records = readRetitleRecords({ storageDir: storage, logsDirectory: logs });
    const byId = new Map(records.map((r) => [r.id, r]));
    expect(byId.get('open-chat')?.open).toBe(true);
    expect(byId.get('owner-named')?.title).toBe('Tractor beam work');
    // A log-sourced archive row has no body: its lines come from the session log.
    expect(byId.get('log-named')?.firstUserLine).toBe(prompt);
    expect(byId.get('log-named')?.lastAssistantLine).toBe('Beam fixed.');
  });

  it('the scheduler records an unwired retitle action as a failed run', async () => {
    // `retitle` needs a workspace storage folder and a host facade, neither of
    // which a window without a sidebar has. Without that guard the job would
    // look like it ran and did nothing.
    await savedJobFile();
    const scheduler = new JobScheduler({
      store,
      power: new PowerControl(),
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }),
      workspaceId: 'workspace',
      instanceId: 'instance',
      leaseDirectory: jobsRoot,
      now: () => new Date(),
      notifyLocal: () => undefined,
      tickMs: 30_000,
    });
    await scheduler.start({ immediate: false });
    await scheduler.tick();
    const runs = await store.readRuns('retitle-daily');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: 'failed',
      changed: true,
      error: 'retitle runner not wired (no storage folder for this workspace)',
      delivered: 0,
    });
  });

  it('a deleted job stops before writing anything', async () => {
    const runner = new RetitleRunner(deps());
    const file = await savedJobFile();
    await store.delete(file.job.id);
    await runner.run(file, false);
    expect(await store.readRuns(file.job.id)).toHaveLength(0);
  });

  it('a dead model is recorded as a failed run, not thrown past the job', async () => {
    // The gap this closes: `errors` was read by the run row and by the
    // sentence but never written, so a failed request threw out of `run()`
    // into the scheduler's `void ... .finally()` and the job got no run row,
    // no failure count and no backoff.
    const applied: Array<[string, string]> = [];
    let first = true;
    const runner = new RetitleRunner({
      ...deps({ host: () => fakeHost(applied) }),
      summarize: async () => {
        if (first) {
          first = false;
          throw new Error('model slot busy');
        }
        return 'Orbital salvage beam fix';
      },
    });
    await runner.run(await savedJobFile({ max_chats: 20 }), false);
    // The other chat is still named: one dead request must not take the batch
    // down with it.
    expect(applied).toHaveLength(1);
    const runs = await store.readRuns('retitle-daily');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: 'failed',
      error: 'model slot busy',
      summary: expect.stringContaining('1 model request(s) failed'),
    });
    const state = (await store.load('retitle-daily'))!.state;
    expect(state.consecutive_failures).toBe(1);
    expect(state.last_ok_at).toBeNull();
  });

  it('a turn starting partway through stops the pass instead of burning the GPU', async () => {
    // The admission gate is checked once, before the scan. Without a check in
    // the loop a batch of twelve keeps asking after the owner started a turn,
    // which is exactly the competition `jobs.gpu_gate` exists to prevent.
    const applied: Array<[string, string]> = [];
    let asks = 0;
    let streaming = false;
    const runner = new RetitleRunner({
      ...deps({ host: () => fakeHost(applied) }),
      summarize: async () => {
        asks += 1;
        streaming = true;
        return 'Orbital salvage beam fix';
      },
      busy: () => (streaming ? 'a turn is streaming' : undefined),
    });
    await runner.run(await savedJobFile({ max_chats: 20 }), false);
    expect(asks).toBe(1);
    expect(applied).toHaveLength(1);
    const runs = await store.readRuns('retitle-daily');
    expect(runs[0]?.summary).toContain('stopped early: a turn started');
  });

  it('a job deleted while its pass is asking stops at once and writes no run row', async () => {
    const applied: Array<[string, string]> = [];
    const runner = new RetitleRunner({
      ...deps({ host: () => fakeHost(applied) }),
      summarize: async () => {
        // The owner deletes the job between two asks.
        await store.delete('retitle-daily');
        return 'Orbital salvage beam fix';
      },
    });
    const file = await savedJobFile({ max_chats: 20 });
    await runner.run(file, false);
    // The first title still lands; the second is never asked for, because the
    // job it would have been written for no longer exists.
    expect(applied).toHaveLength(1);
    expect(await store.readRuns(file.job.id)).toHaveLength(0);
  });
});
