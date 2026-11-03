import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultState, JobStore } from '../../src/jobs/JobStore';
import { JobSchema, JobStateSchema, type Job, type JobFile } from '../../src/jobs/jobSchema';
import {
  buildJobsPanelSnapshot,
  JOB_DETAIL_MAX_CHARS,
} from '../../src/jobs/jobPanelSnapshot';

let root: string;
let store: JobStore;

function job(overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    version: 1,
    id: 'alpha',
    name: 'Alpha',
    enabled: true,
    wake: false,
    after: 'stay_awake',
    schedule: { kind: 'daily', at: '07:00' },
    check: { kind: 'none' },
    on_change: { kind: 'notify' },
    action: null,
    created_at: 100,
    updated_at: 0,
    ...overrides,
  });
}

/** A full state, so a test patches what it means to and inherits the rest. */
function state(over: Record<string, unknown> = {}) {
  return JobStateSchema.parse({ ...defaultState(), ...over });
}

/** Three jobs: two created at different times, two sharing a creation time so
 *  the id tie-break decides — the same order Telegram `/jobs` numbers them. */
async function seedStore(target: JobStore): Promise<void> {
  await target.saveJob(job({ id: 'alpha', name: 'Alpha', created_at: 100 }));
  await target.saveJob(
    job({
      id: 'beta',
      name: 'Beta',
      created_at: 200,
      schedule: { kind: 'interval', minutes: 15 },
      action: { kind: 'agent_task', task: 'check the thing', report: 'always' },
    }),
  );
  await target.saveJob(job({ id: 'gamma', name: 'Gamma', created_at: 200 }));
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-panel-'));
  store = new JobStore(root);
  await seedStore(store);
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('buildJobsPanelSnapshot', () => {
  it('lists jobs in the canonical creation order the store gives', async () => {
    const rows = await buildJobsPanelSnapshot(store);
    expect(rows.map((row) => row.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(rows.map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('shows a never-run job its schedule and says it has not run', async () => {
    const [alpha] = await buildJobsPanelSnapshot(store);
    expect(alpha?.schedule).toBe('daily at 07:00');
    expect(alpha?.enabled).toBe(true);
    expect(alpha?.lastRun).toBeNull();
    expect(alpha?.lastOutcomeLabel).toBe('no runs yet');
    // The count behind the label, as a number: the panel's status dot and its
    // Jobs-tab badge decide from this, never from the wording of the label.
    expect(alpha?.consecutiveFailures).toBe(0);
    expect(alpha?.runningConversationId).toBeNull();
    // The row's tooltip is the same text `manage_jobs get` returns.
    expect(alpha?.description).toContain('status: enabled');
    expect(alpha?.description).toContain('schedule: daily at 07:00');
  });

  it('marks a paused job paused without losing its schedule', async () => {
    await store.saveJob(job({ id: 'alpha', enabled: false }));
    const [alpha] = await buildJobsPanelSnapshot(store);
    expect(alpha?.enabled).toBe(false);
    expect(alpha?.schedule).toBe('daily at 07:00');
    expect(alpha?.description).toContain('status: paused');
  });

  it('reads the newest run for its outcome and detail', async () => {
    const at = 1_700_000_000_000;
    await store.appendRun('beta', { at, outcome: 'ok', summary: 'ran fine', delivered: 0 });
    await store.appendRun('beta', {
      at: at + 1000,
      outcome: 'failed',
      summary: 'failed',
      error: 'the /unload patch does not apply',
      delivered: 0,
    });
    await store.saveState('beta', state({ last_run_at: at + 1000, consecutive_failures: 1 }));
    const rows = await buildJobsPanelSnapshot(store);
    const beta = rows.find((row) => row.id === 'beta')!;
    // The later row wins, and a failure's detail is its error, not its summary.
    expect(beta.lastRun).toEqual({
      at: at + 1000,
      outcome: 'failed',
      detail: 'the /unload patch does not apply',
    });
    expect(beta.lastOutcomeLabel).toBe('failing ×1');
    expect(beta.consecutiveFailures).toBe(1);
  });

  it('passes a skipped run through as skipped', async () => {
    await store.appendRun('alpha', {
      at: 1_700_000_000_000,
      outcome: 'skipped',
      summary: 'skipped: busy',
      delivered: 0,
    });
    const [alpha] = await buildJobsPanelSnapshot(store);
    expect(alpha?.lastRun?.outcome).toBe('skipped');
    expect(alpha?.lastRun?.detail).toBe('skipped: busy');
  });

  it('clips a long detail to the row limit, so one run cannot widen the panel', async () => {
    await store.appendRun('alpha', {
      at: 1_700_000_000_000,
      outcome: 'failed',
      summary: 'failed',
      error: 'x'.repeat(300),
      delivered: 0,
    });
    const [alpha] = await buildJobsPanelSnapshot(store);
    expect(alpha?.lastRun?.detail).toHaveLength(JOB_DETAIL_MAX_CHARS);
    expect(alpha?.lastRun?.detail.endsWith('…')).toBe(true);
  });

  it('names the running conversation only for an agent_task', async () => {
    const taskRun = { started_at: 1, conversation_id: 'conv-7', heartbeat_at: 1 };
    await store.saveState('beta', state({ task_run: taskRun }));
    await store.saveState('alpha', state({ task_run: taskRun }));
    const rows = await buildJobsPanelSnapshot(store);
    expect(rows.find((row) => row.id === 'beta')?.runningConversationId).toBe('conv-7');
    // `alpha` has no action, so a `task_run` marker on it means nothing: the
    // webview would otherwise show a job Running that no turn is streaming.
    expect(rows.find((row) => row.id === 'alpha')?.runningConversationId).toBeNull();
  });

  it('drops a job deleted between the listing and its own read', async () => {
    // The delete race the panel must not paper over: `loadAll` returns three
    // jobs, one is removed before the projection reads it, and the row is
    // dropped rather than shown stale or resurrected.
    class StoreDeletingAfterList extends JobStore {
      override async loadAll(): Promise<JobFile[]> {
        const listed = await super.loadAll();
        await this.delete(listed[2]!.job.id);
        return listed;
      }
    }
    const racing = new StoreDeletingAfterList(root);
    const rows = await buildJobsPanelSnapshot(racing);
    expect(rows.map((row) => row.id)).toEqual(['alpha', 'beta']);
    expect(await racing.load('gamma')).toBeUndefined();
  });

  it('rejects rather than returning a list that looks empty', async () => {
    class BrokenStore extends JobStore {
      override async loadAll(): Promise<JobFile[]> {
        throw new Error('EACCES: permission denied');
      }
    }
    await expect(buildJobsPanelSnapshot(new BrokenStore(root))).rejects.toThrow(
      'permission denied',
    );
  });
});
