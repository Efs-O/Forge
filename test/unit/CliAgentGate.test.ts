import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLI_AGENT_CONSENT_DETAIL,
  cliAgentSkip,
  isCliAgentModel,
  makeAllowCliAgents,
  unattendedCliRefusal,
} from '../../src/jobs/cliAgentGate';
import { JobStore } from '../../src/jobs/JobStore';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import { makeManageJobsTool } from '../../src/tools/jobTools';
import type { ForgeConfig } from '../../src/config/types';

function makeConfig(allow: boolean): ForgeConfig {
  return {
    active_model: 'qwen',
    llama_server: {},
    models: [
      { name: 'qwen', gguf_path: '/qwen.gguf' },
      { name: 'claude-code', provider: 'cli', cli: 'claude' },
    ],
    jobs: { enabled: true, allowed_hosts: [], max_concurrent: 1, allow_cli_agents: allow },
  } as ForgeConfig;
}

const createArgs = (model?: string): Record<string, unknown> => ({
  action: 'create',
  definition: {
    name: 'Nightly',
    schedule: { kind: 'interval', minutes: 60 },
    check: { kind: 'none' },
    on_change: { kind: 'notify' },
    action: { kind: 'agent_task', task: 'refactor', ...(model ? { model } : {}) },
  },
});

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-cli-gate-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('cliAgentGate', () => {
  it('recognises a provider: cli model, and nothing else', () => {
    const config = makeConfig(false);
    expect(isCliAgentModel(config, 'claude-code')).toBe(true);
    expect(isCliAgentModel(config, 'qwen')).toBe(false);
    expect(isCliAgentModel(config, 'no-such-model')).toBe(false);
  });

  it('skips a CLI-agent run while the flag is off, runs it once allowed', () => {
    expect(cliAgentSkip(makeConfig(false), 'claude-code', 5, true)).toMatchObject({
      at: 5,
      late: true,
      outcome: 'skipped',
    });
    expect(cliAgentSkip(makeConfig(true), 'claude-code', 5, false)).toBeUndefined();
    expect(cliAgentSkip(makeConfig(false), 'qwen', 5, false)).toBeUndefined();
  });

  it('refuses delegation only inside an unattended job turn with the flag off', () => {
    const marker = unattendedConversations.mark('job-conv');
    try {
      expect(unattendedCliRefusal(makeConfig(false), 'job-conv')).toMatch(/allow_cli_agents/);
      expect(unattendedCliRefusal(makeConfig(true), 'job-conv')).toBeUndefined();
      expect(unattendedCliRefusal(makeConfig(false), 'chat-conv')).toBeUndefined();
    } finally {
      marker.dispose();
    }
  });

  it('the consent write sets the flag and keeps the file comments', () => {
    const file = path.join(root, 'config.yaml');
    const yaml = [
      '# my VRAM notes',
      'active_model: qwen',
      'llama_server:',
      '  binary: /llama-server',
      'models:',
      '  - name: qwen',
      '    gguf_path: /qwen.gguf',
      'jobs:',
      '  enabled: true # keep me',
      '',
    ];
    fs.writeFileSync(file, yaml.join('\n'));
    makeAllowCliAgents(file)();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# my VRAM notes');
    expect(text).toContain('# keep me');
    expect(text).toMatch(/allow_cli_agents: true/);
  });
});

describe('manage_jobs consent', () => {
  it('asks (dangerous) before a CLI-agent job, and approving writes the flag', async () => {
    const allowCliAgents = vi.fn();
    const tool = makeManageJobsTool({
      store: new JobStore(root),
      getConfig: () => makeConfig(false),
      allowCliAgents,
    });
    expect(tool.approval?.(createArgs('claude-code'))).toEqual({
      dangerous: true,
      detail: CLI_AGENT_CONSENT_DETAIL,
    });
    await tool.handler(createArgs('claude-code'));
    expect(allowCliAgents).toHaveBeenCalledTimes(1);
  });

  it('does not ask for a local model or once allowed', () => {
    const local = makeManageJobsTool({ store: new JobStore(root), getConfig: () => makeConfig(false) });
    expect(local.approval?.(createArgs('qwen'))).toBeUndefined();
    expect(local.approval?.(createArgs())).toBeUndefined(); // pins active_model (qwen)
    const allowed = makeManageJobsTool({ store: new JobStore(root), getConfig: () => makeConfig(true) });
    expect(allowed.approval?.(createArgs('claude-code'))).toBeUndefined();
  });
});
