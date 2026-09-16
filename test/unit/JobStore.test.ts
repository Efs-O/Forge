import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../../src/jobs/JobStore';
import { JobSchema, type Job } from '../../src/jobs/jobSchema';

let root: string;
let store: JobStore;

function job(overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    version: 1,
    id: 'disk',
    name: 'Disk',
    enabled: true,
    wake: false,
    after: 'stay_awake',
    schedule: { kind: 'interval', minutes: 15 },
    check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
    on_change: { kind: 'notify' },
    action: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  });
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-store-'));
  store = new JobStore(root);
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('JobStore', () => {
  it('saves and loads a job, giving a default state when none exists', async () => {
    await store.saveJob(job());
    const loaded = await store.load('disk');
    expect(loaded?.job.name).toBe('Disk');
    expect(loaded?.state.next_due_at).toBeNull();
    expect(loaded?.state.consecutive_failures).toBe(0);
  });

  it('persists state in a separate file from the definition', async () => {
    await store.saveJob(job());
    await store.saveState('disk', {
      last_run_at: 1,
      last_ok_at: 1,
      last_observation: 'x',
      consecutive_failures: 2,
      next_due_at: 99,
      conversation_id: null,
      summary_pending: false,
    });
    // The definition file has no state; the state file does.
    const defRaw = await fs.promises.readFile(path.join(root, 'disk.json'), 'utf8');
    expect(defRaw).not.toContain('next_due_at');
    const stateRaw = await fs.promises.readFile(path.join(root, 'state', 'disk.json'), 'utf8');
    expect(stateRaw).toContain('next_due_at');
    expect((await store.load('disk'))!.state.consecutive_failures).toBe(2);
  });

  it('a malformed job file is reported, not skipped silently', async () => {
    await store.ensureDirs();
    await fs.promises.writeFile(path.join(root, 'bad.json'), '{not json');
    await expect(store.loadAll()).rejects.toThrow(/bad\.json/);
  });

  it('a corrupt state file falls back to the default state', async () => {
    await store.saveJob(job());
    await store.ensureDirs();
    await fs.promises.writeFile(path.join(root, 'state', 'disk.json'), 'garbage');
    const loaded = await store.load('disk');
    expect(loaded?.state.next_due_at).toBeNull();
  });

  it('patchState updates only the patched field, preserving the rest', async () => {
    await store.saveJob(job());
    await store.saveState('disk', {
      last_run_at: 100,
      last_ok_at: 100,
      last_observation: 'obs',
      consecutive_failures: 2,
      next_due_at: 500,
      conversation_id: null,
      summary_pending: true,
    });
    // Patch only conversation_id; the other fields must survive.
    store.patchState('disk', { conversation_id: 'conv-9' });
    const loaded = (await store.load('disk'))!;
    expect(loaded.state.conversation_id).toBe('conv-9');
    expect(loaded.state.last_run_at).toBe(100);
    expect(loaded.state.consecutive_failures).toBe(2);
    expect(loaded.state.next_due_at).toBe(500);
    expect(loaded.state.summary_pending).toBe(true);
  });

  it('patchState works when no state file exists yet', async () => {
    await store.saveJob(job());
    store.patchState('disk', { conversation_id: 'conv-1' });
    expect((await store.load('disk'))?.state.conversation_id).toBe('conv-1');
    // The rest of the state is the default.
    expect((await store.load('disk'))?.state.last_run_at).toBeNull();
  });

  it('patchState treats malformed state as the default, like load does', async () => {
    await store.saveJob(job());
    const stateFile = path.join(root, 'state', 'disk.json');
    await fs.promises.writeFile(stateFile, '{ not json', 'utf8');

    store.patchState('disk', { conversation_id: 'conv-1' });

    const loaded = (await store.load('disk'))!;
    expect(loaded.state).toEqual({
      last_run_at: null,
      last_ok_at: null,
      last_observation: null,
      consecutive_failures: 0,
      next_due_at: null,
      conversation_id: 'conv-1',
      summary_pending: false,
    });
  });

  it('loadAll returns jobs in a deterministic order (creation, then id)', async () => {
    // Write in an order that is not the canonical one; the store must not rely
    // on readdir order (which is platform-dependent).
    await store.saveJob(job({ id: 'zeta', name: 'Zeta', created_at: 3 }));
    await store.saveJob(job({ id: 'alpha', name: 'Alpha', created_at: 1 }));
    await store.saveJob(job({ id: 'mid', name: 'Mid', created_at: 2 }));
    const all = await store.loadAll();
    expect(all.map((jf) => jf.job.id)).toEqual(['alpha', 'mid', 'zeta']);
    // A tie on created_at breaks by id.
    await store.saveJob(job({ id: 'tie-a', name: 'Tie A', created_at: 5 }));
    await store.saveJob(job({ id: 'tie-b', name: 'Tie B', created_at: 5 }));
    const ties = (await store.loadAll())
      .filter((jf) => jf.job.created_at === 5)
      .map((jf) => jf.job.id);
    expect(ties).toEqual(['tie-a', 'tie-b']);
  });
});

describe('JobStore run log', () => {
  it('appends run rows only; they are never rewritten', async () => {
    const row = (at: number) => ({
      at,
      late: false,
      outcome: 'ok' as const,
      changed: false,
      summary: 'ran',
      delivered: 0,
    });
    await store.appendRun('disk', row(1));
    await store.appendRun('disk', row(2));
    await store.appendRun('disk', row(3));
    const runs = await store.readRuns('disk');
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.at)).toEqual([1, 2, 3]);
  });

  it('readRuns returns empty when there is no log yet', async () => {
    expect(await store.readRuns('disk')).toEqual([]);
  });

  it('a run row that violates the schema is rejected', async () => {
    await expect(
      store.appendRun('disk', { at: 1, outcome: 'bogus', summary: 'x' } as never),
    ).rejects.toThrow();
  });
});

describe('JobStore delete', () => {
  it('removes the definition, state, and run log', async () => {
    await store.saveJob(job());
    await store.saveState('disk', {
      last_run_at: 1,
      last_ok_at: 1,
      last_observation: null,
      consecutive_failures: 0,
      next_due_at: null,
      conversation_id: null,
      summary_pending: false,
    });
    await store.appendRun('disk', {
      at: 1,
      late: false,
      outcome: 'ok',
      changed: false,
      summary: 'ran',
      delivered: 0,
    });
    await store.delete('disk');
    expect(await store.load('disk')).toBeUndefined();
    expect(await store.readRuns('disk')).toEqual([]);
    await expect(fs.promises.access(path.join(root, 'state', 'disk.json'))).rejects.toThrow();
  });

  it('delete is idempotent for a job that never existed', async () => {
    await expect(store.delete('ghost')).resolves.toBeUndefined();
  });
});
