import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import type { ForgeConfig } from '../../src/config/types';

/**
 * Side change A (TOOL_SURFACE_AND_SHELL_ACCESS_PLAN.md): the four
 * `agent_bus.{codex,claude}_{model,effort}` keys must reach
 * `factory.create()` for a Forge-owned Codex/Claude session, and must be
 * absent from the call when unset — a config that never sets them keeps
 * today's `create()` call byte-identical.
 */

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-model-effort-'));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

function fakeCodexSession(): unknown {
  return {
    confirmedSessionId: 'fixture-thread-id',
    pid: 1234,
    send: async () => ({ status: 'completed', finalText: 'ok' }),
    interrupt: () => {},
    dispose: async () => {},
  };
}

function fakeClaudeSession(): unknown {
  return {
    confirmedSessionId: 'fixture-session-id',
    pid: 4321,
    send: async () => ({ status: 'completed', finalText: 'ok' }),
    interrupt: () => {},
    dispose: async () => {},
  };
}

describe('OwnedSessionFactory: agent_bus model/effort reach create()', () => {
  it('passes codex_model and codex_effort into the Codex factory.create() call', async () => {
    const calls: unknown[] = [];
    const provider = new MeshSessionProvider({
      busRoot: root,
      getConfig: () =>
        ({
          agent_bus: {
            enabled: true,
            codex_cli: 'codex',
            codex_model: 'gpt-6-luna',
            codex_effort: 'high',
          },
        }) as ForgeConfig,
      workspaceRoots: () => ['/ws'],
      codexFactory: {
        create: async (options) => {
          calls.push(options);
          return fakeCodexSession() as never;
        },
      },
      processStartMs: () => 1_700_000_000_000,
    });

    const result = await provider.resolveAdapter('codex');
    expect(result).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: 'gpt-6-luna', effort: 'high' });
    await provider.dispose();
  });

  it('omits model/effort from the Codex factory.create() call when unset', async () => {
    const calls: unknown[] = [];
    const provider = new MeshSessionProvider({
      busRoot: root,
      getConfig: () => ({ agent_bus: { enabled: true, codex_cli: 'codex' } }) as ForgeConfig,
      workspaceRoots: () => ['/ws'],
      codexFactory: {
        create: async (options) => {
          calls.push(options);
          return fakeCodexSession() as never;
        },
      },
      processStartMs: () => 1_700_000_000_000,
    });

    await provider.resolveAdapter('codex');
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('model');
    expect(calls[0]).not.toHaveProperty('effort');
    await provider.dispose();
  });

  it('passes claude_model and claude_effort into the Claude factory.create() call', async () => {
    const calls: unknown[] = [];
    const provider = new MeshSessionProvider({
      busRoot: root,
      getConfig: () =>
        ({
          agent_bus: {
            enabled: true,
            claude_cli: 'claude',
            claude_model: 'opus',
            claude_effort: 'max',
          },
        }) as ForgeConfig,
      workspaceRoots: () => ['/ws'],
      claudeSessions: () => [],
      claudeFactory: {
        create: async (options) => {
          calls.push(options);
          return fakeClaudeSession() as never;
        },
      },
    });

    const result = await provider.ensureOwnedClaude('claude');
    expect('error' in result).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: 'opus', effort: 'max' });
    await provider.dispose();
  });

  it('omits model/effort from the Claude factory.create() call when unset', async () => {
    const calls: unknown[] = [];
    const provider = new MeshSessionProvider({
      busRoot: root,
      getConfig: () => ({ agent_bus: { enabled: true, claude_cli: 'claude' } }) as ForgeConfig,
      workspaceRoots: () => ['/ws'],
      claudeSessions: () => [],
      claudeFactory: {
        create: async (options) => {
          calls.push(options);
          return fakeClaudeSession() as never;
        },
      },
    });

    await provider.ensureOwnedClaude('claude');
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('model');
    expect(calls[0]).not.toHaveProperty('effort');
    await provider.dispose();
  });
});
