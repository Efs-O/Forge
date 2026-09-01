import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig } from '../../src/config/types';
import { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';
import {
  CliSessionRegistry,
  type CliSessionFactory,
  type WarmCliSession,
} from '../../src/agents/CliSessionRegistry';
import { delegationSessionKey } from '../../src/delegation/CliDelegationRunner';
import { CLI_DELEGATION_TIMEOUT_MS } from '../../src/delegation/limits';
import type { CliAgentSessionOptions } from '../../src/agents/CliAgentSession';

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

interface RecordedFactory {
  factory: CliSessionFactory;
  created: CliAgentSessionOptions[];
  sent: string[];
}

function recordingFactory(): RecordedFactory {
  const created: CliAgentSessionOptions[] = [];
  const sent: string[] = [];
  const factory: CliSessionFactory = (options) => {
    created.push(options);
    const session: WarmCliSession = {
      state: 'idle',
      confirmedSessionId: 'warm-session-id',
      send: async (task: string) => {
        sent.push(task);
        return { status: 'completed' as const, finalText: 'looks fine' };
      },
      dispose: async () => {},
    };
    return session;
  };
  return { factory, created, sent };
}

describe('warm CLI delegation sessions', () => {
  it('reuses one warm process across repeat delegations in the same conversation', async () => {
    const recorded = recordingFactory();
    const registry = new CliSessionRegistry(4, 60_000, recorded.factory);
    const service = new LocalDelegationService({
      getConfig: config,
      workspaceRoot: root,
      backendPool: { canDelegate: vi.fn(), acquireForDelegation: vi.fn() },
      cliDriver: fakeDriver(vi.fn()),
      cliSessions: registry,
    });

    const ask = (task: string) =>
      service.ask({
        primaryModel: 'primary',
        targetModel: 'claude-code',
        task,
        conversationId: 'conv-1',
      });

    expect((await ask('review the auth module')).text).toBe('looks fine');
    expect((await ask('now review the parser')).text).toBe('looks fine');

    // One process for both reviews — the second no longer re-pays the CLI's
    // cold start (system prompt, tool schemas, CLAUDE.md) as a cache miss.
    expect(recorded.created).toHaveLength(1);
    expect(recorded.sent).toHaveLength(2);
    // Each delegation carries its own complete task, not a chat-style follow-up.
    expect(recorded.sent[0]).toContain('review the auth module');
    expect(recorded.sent[1]).toContain('now review the parser');
    await registry.dispose();
  });

  it('creates the session on the delegate key, with the cli timeout', async () => {
    const recorded = recordingFactory();
    const registry = new CliSessionRegistry(4, 60_000, recorded.factory);
    const service = new LocalDelegationService({
      getConfig: config,
      workspaceRoot: root,
      backendPool: { canDelegate: vi.fn(), acquireForDelegation: vi.fn() },
      cliDriver: fakeDriver(vi.fn()),
      cliSessions: registry,
    });

    await service.ask({
      primaryModel: 'primary',
      targetModel: 'claude-code',
      task: 'review',
      conversationId: 'conv-1',
    });

    const options = recorded.created[0];
    expect(options.cliName).toBe('claude');
    // The 120s local-model ceiling would abort a real review mid-flight.
    expect(options.timeoutMs).toBe(CLI_DELEGATION_TIMEOUT_MS);
    // Namespaced away from the sidebar's chat session for the same
    // (conversation, model): registry options apply only at creation, so a
    // shared key would hand one of the two the other's permission mode.
    const key = delegationSessionKey('conv-1', 'claude-code');
    expect(key.modelName).toBe('claude-code#delegate');
    expect(registry.getConfirmedSessionId(key)).toBe('warm-session-id');
    expect(registry.getConfirmedSessionId({ conversationId: 'conv-1', modelName: 'claude-code' }))
      .toBeUndefined();
    await registry.dispose();
  });

  it('falls back to a one-shot spawn when no conversation scopes the call', async () => {
    const recorded = recordingFactory();
    const registry = new CliSessionRegistry(4, 60_000, recorded.factory);
    const run = vi.fn(async () => ({ status: 'completed' as const, finalText: 'one-shot' }));
    const service = new LocalDelegationService({
      getConfig: config,
      workspaceRoot: root,
      backendPool: { canDelegate: vi.fn(), acquireForDelegation: vi.fn() },
      cliDriver: fakeDriver(run),
      cliSessions: registry,
    });

    const result = await service.ask({
      primaryModel: 'primary',
      targetModel: 'claude-code',
      task: 'review',
    });

    expect(result.text).toBe('one-shot');
    expect(recorded.created).toHaveLength(0);
    expect(run.mock.calls[0][0].timeoutMs).toBe(CLI_DELEGATION_TIMEOUT_MS);
    await registry.dispose();
  });
});
