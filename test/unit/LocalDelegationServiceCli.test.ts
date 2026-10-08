import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';
import { CLI_DELEGATION_TIMEOUT_MS } from '../../src/delegation/limits';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: path.resolve('/workspace') } }] },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

const root = path.resolve('/workspace');

/**
 * A hermetic fake CLI executable: a real file whose basename infers as
 * `claude`, so `inferCliAgentName` accepts it and `resolveCliExecutable`
 * returns it without a PATH lookup.
 */
const FAKE_CLAUDE_CLI = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fake-cli-'));
  const file = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.writeFileSync(file, '');
  return file;
})();

function config(): ForgeConfig {
  return {
    models: [{ name: 'claude-code', provider: 'cli', cli: FAKE_CLAUDE_CLI }],
    active_model: 'primary',
    llama_server: {},
  };
}

function fakeDriver(run: CliAgentDriver['run']): CliAgentDriver {
  return { run } as unknown as CliAgentDriver;
}

describe('LocalDelegationService ask() for provider: cli targets', () => {
  it('runs the cli driver and never touches the backend pool', async () => {
    const run = vi.fn(async () => ({ status: 'completed' as const, finalText: 'looks fine' }));
    const canDelegate = vi.fn();
    const acquireForDelegation = vi.fn();
    const service = new LocalDelegationService({
      getConfig: config,
      workspaceRoot: root,
      backendPool: { canDelegate, acquireForDelegation },
      cliDriver: fakeDriver(run),
    });

    const result = await service.ask({
      primaryModel: 'primary',
      targetModel: 'claude-code',
      task: 'review the auth module for security issues',
    });

    expect(result.text).toBe('looks fine');
    expect(result.targetModel).toBe('claude-code');
    expect(canDelegate).not.toHaveBeenCalled();
    expect(acquireForDelegation).not.toHaveBeenCalled();
    const call = run.mock.calls[0][0];
    expect(call.cliName).toBe('claude');
  });

  it('wraps a non-completed cli run as a delegation error', async () => {
    const run = vi.fn(async () => ({
      status: 'failed' as const,
      finalText: '',
      error: 'claude CLI exited with code 1',
    }));
    const service = new LocalDelegationService({
      getConfig: config,
      workspaceRoot: root,
      backendPool: { canDelegate: vi.fn(), acquireForDelegation: vi.fn() },
      cliDriver: fakeDriver(run),
    });

    await expect(
      service.ask({ primaryModel: 'primary', targetModel: 'claude-code', task: 'review' }),
    ).rejects.toThrow('claude CLI exited with code 1');
  });
});

describe('CLI delegation sessions', () => {
  it('runs each CLI delegation as a fresh one-shot invocation', async () => {
    const run = vi.fn(async () => ({ status: 'completed' as const, finalText: 'looks fine' }));
    const service = new LocalDelegationService({
      getConfig: config,
      workspaceRoot: root,
      backendPool: { canDelegate: vi.fn(), acquireForDelegation: vi.fn() },
      cliDriver: fakeDriver(run),
    });

    for (const task of ['review the auth module', 'review the parser']) {
      await service.ask({
        primaryModel: 'primary',
        targetModel: 'claude-code',
        task,
        conversationId: 'conv-1',
      });
    }

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([call]) => call.task)).toEqual([
      expect.stringContaining('review the auth module'),
      expect.stringContaining('review the parser'),
    ]);
    expect(run.mock.calls[0]?.[0].timeoutMs).toBe(CLI_DELEGATION_TIMEOUT_MS);
  });
});
