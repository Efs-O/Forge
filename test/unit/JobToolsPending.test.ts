import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { JobStore } from '../../src/jobs/JobStore';
import { JobSchema } from '../../src/jobs/jobSchema';
import { makeManageJobsTool } from '../../src/tools/jobTools';

let root: string;
let store: JobStore;
let tool: ReturnType<typeof makeManageJobsTool>;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-jobs-pending-'));
  store = new JobStore(root);
  const config: ForgeConfig = {
    active_model: 'local',
    llama_server: {},
    models: [{ name: 'local', gguf_path: 'local.gguf' }],
    jobs: { enabled: true, allowed_hosts: [], max_concurrent: 1, allow_cli_agents: false },
  };
  tool = makeManageJobsTool({ store, getConfig: () => config });
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('manage_jobs pending reason', () => {
  it('shows the latest pending reason in list and inspect', async () => {
    const job = JobSchema.parse({
      version: 1,
      id: 'gpu',
      name: 'GPU task',
      schedule: { kind: 'interval', minutes: 15 },
      check: { kind: 'none' },
      on_change: { kind: 'notify' },
      action: { kind: 'agent_task', task: 'run' },
    });
    await store.saveJob(job);
    store.patchState('gpu', {
      task_pending: true,
      task_pending_reason: 'GPU 0 at 41% (limit 1%)',
    });

    const list = await tool.handler({ action: 'list' });
    const inspect = await tool.handler({ action: 'get', job: 'gpu' });
    expect(list).toContain('pending: GPU 0 at 41% (limit 1%)');
    expect(inspect).toContain('pending: GPU 0 at 41% (limit 1%)');
  });
});
