import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobScheduler } from '../../src/jobs/JobScheduler';
import { JobStore } from '../../src/jobs/JobStore';
import {
  ActionSchema,
  CheckSchema,
  JobSchema,
  JobStateSchema,
  type Job,
} from '../../src/jobs/jobSchema';
import { runCheck, buildCheckContext } from '../../src/jobs/checks/runCheck';
import { jobDefaultModel } from '../../src/config/jobsSchema';
import type { ForgeConfig } from '../../src/config/types';
import { PowerControl } from '../../src/system/PowerControl';

let jobsRoot: string | undefined;
let scheduler: JobScheduler | undefined;

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

afterEach(async () => {
  await scheduler?.stop();
  if (jobsRoot) await fs.promises.rm(jobsRoot, { recursive: true, force: true });
  scheduler = undefined;
  jobsRoot = undefined;
});

describe('agent task phase 1 schema', () => {
  it('parses the none check', () => {
    expect(CheckSchema.parse({ kind: 'none' })).toEqual({ kind: 'none' });
  });

  it('parses agent_task with the failure-and-changes report default', () => {
    expect(ActionSchema.parse({ kind: 'agent_task', task: 'do the task' })).toMatchObject({
      kind: 'agent_task',
      task: 'do the task',
      report: 'failures_and_changes',
    });
  });

  it('rejects invalid agent task values', () => {
    expect(() => ActionSchema.parse({ kind: 'agent_task', task: 'x'.repeat(8000) })).not.toThrow();
    expect(() => ActionSchema.parse({ kind: 'agent_task', task: 'x'.repeat(8001) })).toThrow();
    expect(() => ActionSchema.parse({ kind: 'agent_task', task: '' })).toThrow();
    expect(() =>
      ActionSchema.parse({ kind: 'agent_task', task: 'do it', max_minutes: 0 }),
    ).toThrow();
  });

  it('defaults task state fields for an old state file', () => {
    const state = JobStateSchema.parse({
      last_run_at: null,
      last_ok_at: null,
      last_observation: null,
      consecutive_failures: 0,
      next_due_at: null,
      conversation_id: null,
      summary_pending: false,
      summary_failures: 0,
      summary_retry_at: null,
    });
    expect(state.task_run).toBeNull();
    expect(state.task_pending).toBe(false);
    expect(state.task_pending_reason).toBeNull();
  });
});

describe('agent task phase 1 check and scheduler guard', () => {
  it('none reports changed with an empty observation', async () => {
    const job = baseJob();
    const state = JobStateSchema.parse({});
    const result = await runCheck(
      { job, state },
      buildCheckContext([], job.id, new Map<string, string>()),
    );
    expect(result).toMatchObject({ changed: true, observation: '' });
  });

  it('records an unwired agent task as failed without delivering', async () => {
    jobsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-agent-task-'));
    const store = new JobStore(jobsRoot);
    await store.saveJob(baseJob());
    const toasts: string[] = [];
    scheduler = new JobScheduler({
      store,
      power: new PowerControl(),
      getConfig: () => ({ allowedHosts: [], maxConcurrent: 1 }),
      workspaceId: 'workspace',
      instanceId: 'instance',
      leaseDirectory: jobsRoot,
      now: () => new Date('2026-01-01T00:00:00Z'),
      notifyLocal: (text) => toasts.push(text),
      tickMs: 30_000,
    });
    await scheduler.start({ immediate: false });
    await scheduler.tick();

    const runs = await store.readRuns('agent-task');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: 'failed',
      changed: true,
      error: 'agent_task runner not wired (no host facade or backend pool)',
      delivered: 0,
    });
    expect(toasts).toEqual([]);
    await expect(
      fs.promises.access(path.join(jobsRoot, 'outbox', 'agent-task.json')),
    ).rejects.toThrow();
  });
});

/**
 * `jobs.default_model` is the one model setting no chat-tab switch ever moves,
 * so it is the one most likely to outlive the model it names. It used to fail
 * three turns later as the backend's generic "unknown model", which read as a
 * broken job; the resolver now says what happened, and `AgentTaskRunner` asks it
 * at the start instead of mid-turn.
 */
describe('jobDefaultModel', () => {
  function jobsConfig(defaultModel?: string): ForgeConfig {
    return {
      models: [
        { name: 'keep', provider: 'llama.cpp', gguf_path: '/models/keep.gguf', short_name: 'k' },
      ],
      active_model: 'keep',
      llama_server: { binary: 'llama-server' },
      ...(defaultModel === undefined
        ? {}
        : { jobs: { enabled: true, default_model: defaultModel } }),
    } as ForgeConfig;
  }

  it('uses jobs.default_model when it names a configured model', () => {
    expect(jobDefaultModel(jobsConfig('keep'))).toBe('keep');
  });

  it('accepts a jobs model written as its short_name', () => {
    expect(jobDefaultModel(jobsConfig('k'))).toBe('k');
  });

  it('falls back to active_model when the field is absent', () => {
    expect(jobDefaultModel(jobsConfig())).toBe('keep');
    const noActive = jobsConfig();
    noActive.active_model = null;
    expect(jobDefaultModel(noActive)).toBeUndefined();
  });

  it('names the field to set when the jobs model was removed', () => {
    expect(() => jobDefaultModel(jobsConfig('strata-flashnext-iq2xs'))).toThrow(
      'the jobs model "strata-flashnext-iq2xs" was removed from config.yaml; set `jobs.default_model` to a configured model.',
    );
  });
});
