import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobStore } from '../../src/jobs/JobStore';
import { JobSchema, type Job } from '../../src/jobs/jobSchema';
import { makeManageJobsTool, type ManageJobsDeps } from '../../src/tools/jobTools';
import { ToolRegistry, type RegisteredTool } from '../../src/tools/ToolRegistry';
import type { ForgeConfig } from '../../src/config/types';

const workspaceMock = vi.hoisted(() => ({
  folders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
}));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return workspaceMock.folders;
    },
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }),
  },
}));

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

async function call(
  args: Record<string, unknown>,
  depsOverride?: Partial<ManageJobsDeps>,
): Promise<string> {
  const t = depsOverride ? makeManageJobsTool(deps(depsOverride)) : tool;
  return t.handler(args) as Promise<string>;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-tools-'));
  store = new JobStore(root);
  jobsEnabled = true;
  getConfig = () =>
    makeConfig(jobsEnabled ? { enabled: true, allowed_hosts: [], max_concurrent: 1 } : undefined);
  workspaceMock.folders = undefined;
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
    const deletion = tool.approval?.({ action: 'delete', job: 'disk' });
    expect(deletion?.dangerous).toBe(true);
    expect(deletion?.clankerStop).toBe(true);
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

  it('refuses a wake job off Windows and names the supported alternative', async () => {
    await expect(
      call(
        {
          action: 'create',
          definition: {
            name: 'Wake me',
            wake: true,
            schedule: { kind: 'daily', at: '08:00' },
            check: { kind: 'none' },
            on_change: { kind: 'notify' },
          },
        },
        { platform: 'linux' },
      ),
    ).rejects.toThrow(/wake is Windows-only; omit it/u);
    expect(await store.loadAll()).toEqual([]);
  });

  it('schedules a new daily job for its time instead of running it on the next tick', async () => {
    const before = Date.now();
    const out = await call({
      action: 'create',
      definition: {
        name: 'Thread Watch',
        schedule: { kind: 'daily', at: '08:20' },
        check: { kind: 'none' },
        on_change: { kind: 'notify' },
      },
    });
    expect(out).toContain('First run:');
    const loaded = await store.load('thread-watch');
    const due = loaded!.state.next_due_at!;
    expect(due).toBeGreaterThan(before);
    expect(new Date(due).getHours()).toBe(8);
    expect(new Date(due).getMinutes()).toBe(20);
  });

  it('writes the current model into an agent_task created without one', async () => {
    const out = await call({
      action: 'create',
      definition: {
        name: 'Watch',
        schedule: { kind: 'daily', at: '08:00' },
        check: { kind: 'none' },
        on_change: { kind: 'notify' },
        action: { kind: 'agent_task', task: 'look' },
      },
    });
    expect(out).toContain('Its agent runs on primary.');
    const loaded = await store.load('watch');
    expect(loaded?.job.action).toMatchObject({ kind: 'agent_task', model: 'primary' });
  });

  it('follows jobs.default_model instead of pinning when it is set', async () => {
    const config = makeConfig({
      enabled: true,
      allowed_hosts: [],
      max_concurrent: 1,
      default_model: 'steady',
    });
    const out = await call(
      {
        action: 'create',
        definition: {
          name: 'Watch',
          schedule: { kind: 'daily', at: '08:00' },
          check: { kind: 'none' },
          on_change: { kind: 'notify' },
          action: { kind: 'agent_task', task: 'look' },
        },
      },
      { getConfig: () => config },
    );
    expect(out).toContain('jobs.default_model (steady)');
    const action = (await store.load('watch'))?.job.action;
    expect(action).toMatchObject({ kind: 'agent_task' });
    expect(action).not.toHaveProperty('model');
  });

  /**
   * `steady` is not in this fixture's `models:` — the jobs model names a model
   * that has been deleted. The create must still succeed (the job is saved and
   * its first run seeded before the sentence is built, and a throw there would
   * report a half-written job as a failure), and it must still say the job
   * cannot run: this is the moment the user can fix the field.
   */
  it('creates the job and says the jobs model is gone', async () => {
    const config = makeConfig({
      enabled: true,
      allowed_hosts: [],
      max_concurrent: 1,
      default_model: 'steady',
    });
    const out = await call(
      {
        action: 'create',
        definition: {
          name: 'Watch',
          schedule: { kind: 'daily', at: '08:00' },
          check: { kind: 'none' },
          on_change: { kind: 'notify' },
          action: { kind: 'agent_task', task: 'look' },
        },
      },
      { getConfig: () => config },
    );
    expect(out).toContain('jobs.default_model (steady)');
    expect(out).toContain('no longer in config.yaml');
    expect((await store.load('watch'))?.job.action).not.toHaveProperty('model');
  });

  it('keeps the model an agent_task names', async () => {
    await call({
      action: 'create',
      definition: {
        name: 'Watch',
        schedule: { kind: 'daily', at: '08:00' },
        check: { kind: 'none' },
        on_change: { kind: 'notify' },
        action: { kind: 'agent_task', task: 'look', model: 'other' },
      },
    });
    expect((await store.load('watch'))?.job.action).toMatchObject({ model: 'other' });
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

  it('reports each invalid definition field in a plain sentence', async () => {
    let message = '';
    try {
      await call({
        action: 'create',
        definition: {
          name: 'Bad',
          schedule: { kind: 'interval', minutes: 5 },
          check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
          on_change: { kind: 'notify' },
        },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'manage_jobs: invalid job definition:\n' +
        'Error: manage_jobs schedule.minutes interval must be at least 15 minutes. ' +
        'To wait for a reply, use `wait` (ends early on a new message).',
    );
    expect(message).toContain('use `wait`');
    expect(message).not.toContain('"issues"');
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

  // Unpinned, an updated agent_task followed every chat-tab model switch (U16-02).
  it('pins the current model into an agent_task replaced by update', async () => {
    await store.saveJob(job({ check: { kind: 'none' } }));
    await call({
      action: 'update',
      job: 'disk',
      definition: { action: { kind: 'agent_task', task: 'look' } },
    });
    const loaded = await store.load('disk');
    expect(loaded?.job.action).toMatchObject({ kind: 'agent_task', model: 'primary' });
  });

  it('a new schedule moves the next run; other state is kept', async () => {
    await store.saveJob(job({ schedule: { kind: 'daily', at: '03:00' } }));
    const old = new Date(2026, 8, 23, 3, 0).getTime();
    const loaded0 = await store.load('disk');
    await store.saveState('disk', { ...loaded0!.state, next_due_at: old, consecutive_failures: 2 });

    const now = new Date(2026, 8, 22, 10, 0);
    await call(
      { action: 'update', job: 'disk', definition: { schedule: { kind: 'daily', at: '09:00' } } },
      { now: () => now },
    );
    const state = (await store.load('disk'))!.state;
    expect(state.next_due_at).toBe(new Date(2026, 8, 23, 9, 0).getTime());
    expect(state.consecutive_failures).toBe(2);
  });

  it('an update without a schedule leaves the next run alone', async () => {
    await store.saveJob(job());
    const loaded0 = await store.load('disk');
    await store.saveState('disk', { ...loaded0!.state, next_due_at: 12345 });
    await call({ action: 'update', job: 'disk', definition: { enabled: false } });
    expect((await store.load('disk'))!.state.next_due_at).toBe(12345);
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
    let message = '';
    try {
      await call({
        action: 'update',
        job: 'disk',
        definition: { schedule: { kind: 'interval', minutes: 5 } },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      'manage_jobs: update rejected:\n' +
        'Error: manage_jobs schedule.minutes interval must be at least 15 minutes. ' +
        'To wait for a reply, use `wait` (ends early on a new message).',
    );
    expect(message).toContain('use `wait`');
    // The job is unchanged on disk.
    expect((await store.load('disk'))?.job.schedule).toEqual({ kind: 'interval', minutes: 15 });
  });

  it('requires a definition object for update', async () => {
    await store.saveJob(job());
    await expect(call({ action: 'update', job: 'disk' })).rejects.toThrow(
      /requires an object `definition`/,
    );
  });

  it('rejects a non-updatable key (including the id) before writing', async () => {
    await store.saveJob(job());
    await expect(
      call({ action: 'update', job: 'disk', definition: { id: 'hacked' } }),
    ).rejects.toThrow(/update cannot set: id/);
    expect((await store.load('disk'))?.job.id).toBe('disk');
    await expect(call({ action: 'update', job: 'disk', definition: { bogus: 1 } })).rejects.toThrow(
      /update cannot set: bogus/,
    );
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

  // Pausing leaves next_due_at behind; a resume that kept it fired every
  // paused job at once (five jobs resumed at 02:30 would all run at 02:30).
  it('resume moves a slot that passed while paused, by either path', async () => {
    const now = new Date(2026, 9, 2, 2, 30);
    const past = new Date(2026, 9, 1, 8, 0).getTime();
    for (const args of [
      { action: 'resume', job: 'disk' },
      { action: 'update', job: 'disk', definition: { enabled: true } },
    ]) {
      await store.saveJob(job({ enabled: false, schedule: { kind: 'daily', at: '08:00' } }));
      await store.saveState('disk', { ...(await store.load('disk'))!.state, next_due_at: past });
      await call(args, { now: () => now });
      expect((await store.load('disk'))?.state.next_due_at).toBe(
        new Date(2026, 9, 2, 8, 0).getTime(),
      );
    }
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

  it('says which window will run a request made from a non-home window', async () => {
    await store.saveJob(job());
    const home = path.join(root, 'home');
    workspaceMock.folders = [{ uri: { fsPath: path.join(root, 'other') } }];
    const out = await call(
      { action: 'run_now', job: 'disk' },
      {
        getConfig: () =>
          makeConfig({
            enabled: true,
            allowed_hosts: [],
            max_concurrent: 1,
            home_workspace: home,
          }),
      },
    );

    expect(out).toContain(`Jobs run in the window for ${home}.`);
    expect(out).toContain("This one runs there on that window's next tick");
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

  it('says which window runs the job when discussing it from a non-home window', async () => {
    await store.saveJob(job());
    const home = path.join(root, 'home');
    workspaceMock.folders = [{ uri: { fsPath: path.join(root, 'other') } }];
    const hostFacade = {
      restoreConversation: async () => {
        throw new Error('no such conversation');
      },
      createConversation: async () => ({ id: 'conv-1' }),
      send: async () => undefined,
    };

    const out = await call(
      { action: 'discuss', job: 'disk' },
      {
        hostFacade: () => hostFacade,
        getConfig: () =>
          makeConfig({
            enabled: true,
            allowed_hosts: [],
            max_concurrent: 1,
            home_workspace: home,
          }),
      },
    );

    expect(out).toContain(`Jobs run in the window for ${home}.`);
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

describe('manage_jobs — pre-approval refusal', () => {
  const registry = new ToolRegistry();

  it('refuses create when the definition was sent in job', () => {
    expect(registry.invalidArgs(tool, { action: 'create', job: ' {"name":"Daily"}' })).toBe(
      'Error: manage_jobs: `create` needs `definition`, the job definition as a JSON object. The definition was sent in `job`, which names an existing job (id or name). Nothing ran. Resend it as `definition`.',
    );
  });

  it('refuses create without a definition', () => {
    expect(registry.invalidArgs(tool, { action: 'create' })).toBe(
      'Error: manage_jobs: `create` needs `definition`, the job definition as a JSON object. Nothing ran.',
    );
  });

  it('refuses update with a string definition before checking job', () => {
    expect(registry.invalidArgs(tool, { action: 'update', job: 'disk', definition: '{}' })).toBe(
      'Error: manage_jobs: `update` needs `definition`, the job definition as a JSON object, not a string. Nothing ran.',
    );
  });

  it('refuses pause without a job', () => {
    expect(registry.invalidArgs(tool, { action: 'pause' })).toBe(
      'Error: manage_jobs: `pause` needs `job`, the id or name of an existing job (list them with {action:"list"}). Nothing ran.',
    );
  });

  it('refuses get with a whitespace-only job', () => {
    expect(registry.invalidArgs(tool, { action: 'get', job: '  ' })).toBe(
      'Error: manage_jobs: `get` needs `job`, the id or name of an existing job (list them with {action:"list"}). Nothing ran.',
    );
  });

  it('allows list', () => {
    expect(registry.invalidArgs(tool, { action: 'list' })).toBeUndefined();
  });

  it('allows create with an object definition', () => {
    expect(registry.invalidArgs(tool, { action: 'create', definition: {} })).toBeUndefined();
  });

  it('allows update with a job and partial object definition', () => {
    expect(
      registry.invalidArgs(tool, {
        action: 'update',
        job: 'x',
        definition: { schedule: { kind: 'daily', at: '08:00' } },
      }),
    ).toBeUndefined();
  });

  it('allows pause with a job', () => {
    expect(registry.invalidArgs(tool, { action: 'pause', job: 'x' })).toBeUndefined();
  });

  it('allows delete with a job', () => {
    expect(registry.invalidArgs(tool, { action: 'delete', job: 'x' })).toBeUndefined();
  });
});

describe('manage_jobs — the store the sessions panel listens to', () => {
  /**
   * The panel subscribes to the one store instance the tool already writes, so
   * no surface needs a callback of its own. This is the seam that test holds
   * still: a tool that kept its own copy of the jobs would leave the panel
   * showing a job that had just been deleted.
   */
  function watchStore(): { count: () => number; stop: () => void } {
    let calls = 0;
    const stop = store.addLocalChangeListener(() => {
      calls += 1;
    });
    return { count: () => calls, stop };
  }

  const create = (name: string): Record<string, unknown> => ({
    action: 'create',
    definition: {
      name,
      schedule: { kind: 'interval', minutes: 30 },
      check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
      on_change: { kind: 'notify' },
    },
  });

  it('a create notifies the panel and lands in the same store', async () => {
    const live = watchStore();
    await call(create('Disk Watch'));
    expect(live.count()).toBeGreaterThanOrEqual(1);
    expect((await store.load('disk-watch'))?.job.name).toBe('Disk Watch');
    live.stop();
  });

  it('a read notifies nothing, so opening the panel cannot make the store churn', async () => {
    await call(create('Disk Watch'));
    const live = watchStore();
    await call({ action: 'list' });
    await call({ action: 'get', job: 'disk-watch' });
    expect(live.count()).toBe(0);
    live.stop();
  });

  it('a delete notifies and the job is gone from that same store', async () => {
    await call(create('Disk Watch'));
    const live = watchStore();
    await call({ action: 'delete', job: 'disk-watch' });
    expect(live.count()).toBeGreaterThanOrEqual(1);
    expect(await store.load('disk-watch')).toBeUndefined();
    live.stop();
  });

  it('discuss persists the chat id through the same store', async () => {
    await store.saveJob(job());
    const live = watchStore();
    const hostFacade = {
      restoreConversation: async (id: string) => ({ id }),
      createConversation: async () => ({ id: 'conv-panel' }),
      send: async () => undefined,
    };
    await call({ action: 'discuss', job: 'disk' }, { hostFacade: () => hostFacade });
    expect(live.count()).toBeGreaterThanOrEqual(1);
    expect((await store.load('disk'))?.state.conversation_id).toBe('conv-panel');
    live.stop();
  });
});
