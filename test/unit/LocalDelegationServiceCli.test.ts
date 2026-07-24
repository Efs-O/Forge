import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: path.resolve('/workspace') } }] },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

const root = path.resolve('/workspace');

function config(): ForgeConfig {
  return {
    models: [{ name: 'claude-code', provider: 'cli', cli: process.execPath }],
    active_model: 'primary',
    llama_server: {},
  };
}

function fakeDriver(run: CliAgentDriver['run']): CliAgentDriver {
  return { run } as unknown as CliAgentDriver;
}

describe('LocalDelegationService ask() for provider: cli targets', () => {
  it('runs the cli driver read-only and never touches the backend pool', async () => {
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
    expect(call.access).toBe('read');
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
