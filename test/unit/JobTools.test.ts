import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../../src/jobs/JobStore';
import { JobSchema, type Job } from '../../src/jobs/jobSchema';
import { makeManageJobsTool, type ManageJobsDeps } from '../../src/tools/jobTools';
import type { RegisteredTool } from '../../src/tools/ToolRegistry';
import type { ForgeConfig } from '../../src/config/types';

let root: string;
let store: JobStore;
let jobsEnabled: boolean;
let getConfig: () => ForgeConfig;
let tool: RegisteredTool;

function makeConfig(jobs?: ForgeConfig['jobs']): ForgeConfig {
  return {
    active_model: 'primary',
    llama_server: {},
    models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
    ...(jobs ? { jobs } : {}),
  } as ForgeConfig;
}

function deps(overrides: Partial<ManageJobsDeps> = {}): ManageJobsDeps {
  return { store, getConfig, ...overrides };
}

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

async function call(args: Record<string, unknown>, depsOverride?: Partial<ManageJobsDeps>): Promise<string> {
  const t = depsOverride ? makeManageJobsTool(deps(depsOverride)) : tool;
  return t.handler(args) as Promise<string>;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-tools-'));
  store = new JobStore(root);
  jobsEnabled = true;
  getConfig = () =>
    makeConfig(jobsEnabled ? { enabled: true, allowed_hosts: [], max_concurrent: 1 } : undefined);
  tool = makeManageJobsTool(deps());
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('manage_jobs — definition and permissions', () => {
  it('is named manage_jobs with a base read permission', () => {
    expect(tool.definition.function.name).toBe('manage_jobs');
    expect(tool.permission).toBe('read');
  });

  it('advertises only when a jobs block is present and enabled', () => {
    expect(tool.advertise!()).toBe(true);
    jobsEnabled = false;
    tool = makeManageJobsTool(deps());
    expect(tool.advertise!()).toBe(false);
  });

  it('derives write for mutating actions and delete for delete', () => {
    const extra = (action: string) => tool.additionalPermissionsForArgs!({ action });
    expect(extra('list')).toEqual([]);
    expect(extra('get')).toEqual([]);
    expect(extra('create')).toEqual(['write']);
    expect(extra('update')).toEqual(['write']);
    expect(extra('pause')).toEqual(['write']);
    expect(extra('resume')).toEqual(['write']);
    expect(extra('run_now')).toEqual(['write']);
    expect(extra('discuss')).toEqual(['write']);
    expect(extra('delete')).toEqual(['delete']);
  });

  it('requires approval (dangerous) only for delete', () => {
    expect(tool.approval?.({ action: 'delete', job: 'disk' })?.dangerous).toBe(true);
    expect(tool.approval?.({ action: 'pause', job: 'disk' })).toBeUndefined();
  });

  it('reports the job files it mutates for write actions', () => {
    expect(tool.mutation!.paths({ action: 'update', job: 'disk' })).toEqual([
      path.join(root, 'disk.json'),
      path.join(root, 'state', 'disk.json'),
    ]);
    expect(tool.mutation!.paths({ action: 'list' })).toEqual([]);
  });
});

describe('manage_jobs — list', () => {
  it('reports no jobs when the store is empty', async () => {
    const out = await call({ action: 'list' });
    expect(out).toContain('No jobs are defined');
  });

  it('lists each job with its schedule and status', async () => {
    await store.saveJob(job());
    const out = await call({ action: 'list' });
    expect(out).toContain('Disk');
    expect(out).toContain('[disk]');
    expect(out).toContain('every 15 min');
    expect(out).toContain('enabled');
  });
});

describe('manage_jobs — create', () => {
  it('creates a job from a full definition and generates an id', async () => {
    const out = await call({
      action: 'create',
      definition: {
        name: 'Disk Watch',
        schedule: { kind: 'interval', minutes: 30 },
        check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
        on_change: { kind: 'notify' },
      },
    });
    expect(out).toContain('Created job "Disk Watch" [disk-watch]');
    const loaded = await store.load('disk-watch');
    expect(loaded?.job.name).toBe('Disk Watch');
    expect(loaded?.job.enabled).toBe(true);
  });

  it('suffixes the id when the name already exists', async () => {
    await call({
      action: 'create',
      definition: {
        name: 'Disk Watch',
        schedule: { kind: 'interval', minutes: 30 },
        check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
        on_change: { kind: 'notify' },
      },
    });
    const out = await call({
      action: 'create',
      definition: {
        name: 'Disk Watch',
        schedule: { kind: 'interval', minutes: 30 },
        check: { kind: 'disk_space', path: 'D:\\', min_free_gb: 5 },
        on_change: { kind: 'notify' },
      },
    });
    expect(out).toContain('[disk-watch-2]');
    expect((await store.load('disk-watch-2'))?.job.name).toBe('Disk Watch');
  });

  it('rejects a create with no name', async () => {
    await expect(
      call({
        action: 'create',
        definition: {
          schedule: { kind: 'interval', minutes: 30 },
          check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
          on_change: { kind: 'notify' },
        },
      }),
    ).rejects.toThrow(/needs a `name`/);
  });

  it('rejects an invalid definition (interval below the 15-minute floor)', async () => {
    await expect(
      call({
        action: 'create',
        definition: {
          name: 'Bad',
          schedule: { kind: 'interval', minutes: 5 },
          check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
          on_change: { kind: 'notify' },
        },
      }),
    ).rejects.toThrow(/invalid job definition/);
  });
});

describe('manage_jobs — get and resolution', () => {
  it('resolves an exact id and describes the job', async () => {
    await store.saveJob(job());
    const out = await call({ action: 'get', job: 'disk' });
    expect(out).toContain('Job "Disk" [disk]');
    expect(out).toContain('every 15 min');
  });

  it('resolves a case-insensitive name', async () => {
    await store.saveJob(job());
    const out = await call({ action: 'get', job: 'DISK' });
    expect(out).toContain('Job "Disk" [disk]');
  });

  it('resolves a unique substring match', async () => {
    await store.saveJob(job({ id: 'disk-space', name: 'Disk Space' }));
    const out = await call({ action: 'get', job: 'disk' });
    expect(out).toContain('[disk-space]');
  });

  it('returns the candidates on an ambiguous match instead of guessing', async () => {
    // "llama" is a substring of both ids and neither an exact id nor an exact
    // name, so the resolver must return the candidates rather than guess.
    await store.saveJob(job({ id: 'llama-a', name: 'Llama A' }));
    await store.saveJob(job({ id: 'llama-b', name: 'Llama B' }));
    await expect(call({ action: 'get', job: 'llama' })).rejects.toThrow(/ambiguous/);
  });

  it('throws a helpful error on no match', async () => {
    await store.saveJob(job());
    await expect(call({ action: 'get', job: 'nope' })).rejects.toThrow(/no job matches/);
  });

  it('requires a job reference for get', async () => {
    await expect(call({ action: 'get' })).rejects.toThrow(/required for get/);
  });
});

describe('manage_jobs — update', () => {
  it('applies a partial definition (only the fields present)', async () => {
    await store.saveJob(job());
    const out = await call({
      action: 'update',
      job: 'disk',
      definition: { schedule: { kind: 'interval', minutes: 45 } },
    });
    expect(out).toContain('Updated job "Disk" [disk]');
    const loaded = await store.load('disk');
    expect(loaded?.job.schedule).toEqual({ kind: 'interval', minutes: 45 });
    // The check is untouched by a schedule-only update.
    expect(loaded?.job.check).toEqual({ kind: 'disk_space', path: 'C:\\', min_free_gb: 10 });
  });

  it('never edits the id', async () => {
    await store.saveJob(job());
    await call({
      action: 'update',
      job: 'disk',
      definition: { name: 'Renamed' },
    });
    const loaded = await store.load('disk');
    expect(loaded?.job.id).toBe('disk');
    expect(loaded?.job.name).toBe('Renamed');
  });

  it('rejects an invalid partial before writing', async () => {
    await store.saveJob(job());
    await expect(
      call({
        action: 'update',
        job: 'disk',
        definition: { schedule: { kind: 'interval', minutes: 5 } },
      }),
    ).rejects.toThrow(/update rejected/);
    // The job is unchanged on disk.
    expect((await store.load('disk'))?.job.schedule).toEqual({ kind: 'interval', minutes: 15 });
  });

  it('requires a definition object for update', async () => {
    await store.saveJob(job());
    await expect(call({ action: 'update', job: 'disk' })).rejects.toThrow(/requires an object `definition`/);
  });

  it('rejects a non-updatable key (including the id) before writing', async () => {
    await store.saveJob(job());
    await expect(
      call({ action: 'update', job: 'disk', definition: { id: 'hacked' } }),
    ).rejects.toThrow(/update cannot set: id/);
    expect((await store.load('disk'))?.job.id).toBe('disk');
    await expect(
      call({ action: 'update', job: 'disk', definition: { bogus: 1 } }),
    ).rejects.toThrow(/update cannot set: bogus/);
  });
});

describe('manage_jobs — pause and resume', () => {
  it('pause sets enabled to false', async () => {
    await store.saveJob(job());
    const out = await call({ action: 'pause', job: 'disk' });
    expect(out).toContain('Paused job "Disk" [disk]');
    expect((await store.load('disk'))?.job.enabled).toBe(false);
  });

  it('resume sets enabled back to true', async () => {
    await store.saveJob(job({ enabled: false }));
    const out = await call({ action: 'resume', job: 'disk' });
    expect(out).toContain('Resumed job "Disk" [disk]');
    expect((await store.load('disk'))?.job.enabled).toBe(true);
  });
});

describe('manage_jobs — delete', () => {
  it('removes the job definition, state, and run log', async () => {
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
    const out = await call({ action: 'delete', job: 'disk' });
    expect(out).toContain('Deleted job "Disk" (disk)');
    expect(await store.load('disk')).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'state', 'disk.json'))).toBe(false);
  });

  it('also removes any pending run request for the job', async () => {
    await store.saveJob(job());
    await store.requestRun('disk');
    expect(fs.existsSync(path.join(root, 'run_requests', 'disk'))).toBe(true);
    await call({ action: 'delete', job: 'disk' });
    expect(fs.existsSync(path.join(root, 'run_requests', 'disk'))).toBe(false);
  });
});

describe('manage_jobs — run_now', () => {
  it('writes a run_requests marker the scheduler will consume', async () => {
    await store.saveJob(job());
    const out = await call({ action: 'run_now', job: 'disk' });
    expect(out).toContain('Run requested for "Disk" (disk)');
    expect(fs.existsSync(path.join(root, 'run_requests', 'disk'))).toBe(true);
    // The marker is consumed (and deleted) by the scheduler.
    const consumed = await store.consumeRunRequests();
    expect(consumed).toEqual(['disk']);
    expect(fs.existsSync(path.join(root, 'run_requests', 'disk'))).toBe(false);
  });

  it('round-trips a job id that contains a dot (no extension stripping)', async () => {
    await store.saveJob(job({ id: 'release.v2', name: 'Release v2' }));
    await call({ action: 'run_now', job: 'release.v2' });
    const consumed = await store.consumeRunRequests();
    expect(consumed).toEqual(['release.v2']);
    expect(fs.existsSync(path.join(root, 'run_requests', 'release.v2'))).toBe(false);
  });
});

describe('manage_jobs — discuss', () => {
  it('degrades to a clear error when there is no host facade', async () => {
    await store.saveJob(job());
    await expect(call({ action: 'discuss', job: 'disk' })).rejects.toThrow(
      /`discuss` is not available in this window/,
    );
  });

  it('seeds a new conversation and persists its id', async () => {
    await store.saveJob(job());
    const sent: Array<{ conversationId: string; text: string }> = [];
    let nextId = 'conv-1';
    const hostFacade = {
      restoreConversation: async () => {
        throw new Error('no such conversation');
      },
      createConversation: async () => ({ id: nextId }),
      send: async (conversationId: string, text: string) => {
        sent.push({ conversationId, text });
      },
    };
    const out = await call({ action: 'discuss', job: 'disk' }, { hostFacade: () => hostFacade });
    expect(out).toContain('Opened the discuss chat for "Disk" [disk]');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.conversationId).toBe('conv-1');
    expect(sent[0]!.text).toContain('Job "Disk" [disk]');
    expect(sent[0]!.text).toContain('The user wants to discuss this job.');
    // The conversation id is persisted so the next discuss reuses it.
    expect((await store.load('disk'))?.state.conversation_id).toBe('conv-1');
  });

  it('reuses an existing conversation when it still exists', async () => {
    await store.saveJob(job());
    await store.saveState('disk', {
      last_run_at: null,
      last_ok_at: null,
      last_observation: null,
      consecutive_failures: 0,
      next_due_at: null,
      conversation_id: 'conv-existing',
      summary_pending: false,
    });
    const restored: string[] = [];
    const hostFacade = {
      restoreConversation: async (id: string) => {
        restored.push(id);
      },
      createConversation: async () => ({ id: 'should-not-be-created' }),
      send: async () => undefined,
    };
    await call({ action: 'discuss', job: 'disk' }, { hostFacade: () => hostFacade });
    expect(restored).toEqual(['conv-existing']);
    expect((await store.load('disk'))?.state.conversation_id).toBe('conv-existing');
  });

  it('persists a newly created conversation even when its seed turn fails', async () => {
    await store.saveJob(job());
    const hostFacade = {
      restoreConversation: async () => {
        throw new Error('no such conversation');
      },
      createConversation: async () => ({ id: 'conv-1' }),
      send: async () => {
        throw new Error('seed failed');
      },
    };

    await expect(
      call({ action: 'discuss', job: 'disk' }, { hostFacade: () => hostFacade }),
    ).rejects.toThrow('seed failed');
    expect((await store.load('disk'))?.state.conversation_id).toBe('conv-1');
  });
});

describe('manage_jobs — argument validation', () => {
  it('rejects an unknown action', async () => {
    await expect(call({ action: 'explode' })).rejects.toThrow(/action must be one of/);
  });
});
