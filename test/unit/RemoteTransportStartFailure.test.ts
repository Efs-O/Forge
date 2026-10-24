import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ForgeConfigSchema } from '../../src/config/schema';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteRuntime } from '../../src/remote/RemoteRuntime';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

class FailingChannel extends FakeRemoteChannel {
  override async start(): Promise<void> {
    throw new Error('bot token rejected');
  }
}

class FailsOnceChannel extends FakeRemoteChannel {
  starts = 0;

  override async start(signal: AbortSignal): Promise<void> {
    this.starts += 1;
    if (this.starts === 1) throw new Error('Forge remote state lock timed out');
    await super.start(signal);
  }
}

describe('RemoteTransportManager failed start (U09-02)', () => {
  it('stops the controller it started when the channel fails to start', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-start-failure-'));
    directories.push(directory);
    const approvalSink = { dispose: vi.fn() };
    const questionSink = { dispose: vi.fn() };
    const host = {
      addApprovalSink: () => approvalSink,
      addQuestionSink: () => questionSink,
      status: () => ({
        activeConversationId: undefined,
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
      }),
    } as unknown as ForgeHostFacade;
    const secrets = {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
      onDidChange: vi.fn(),
    } as unknown as vscode.SecretStorage;
    const notifyLocal = vi.fn();
    const runtime = new RemoteRuntime({
      storageDirectory: directory,
      workspaceRoot: directory,
      workspaceId: 'workspace',
      host,
      secrets,
      channelFactories: { telegram: () => new FailingChannel('telegram') },
      notifyLocal,
    });
    await runtime
      .applyConfig(
        ForgeConfigSchema.parse({
          models: [{ name: 'model', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
          remote: { enabled: true, telegram: { enabled: true } },
        }),
      )
      .catch(() => undefined);
    try {
      expect(approvalSink.dispose).toHaveBeenCalledTimes(1);
      expect(questionSink.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('retries a non-lease start failure and sends the pending arrival receipt', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-start-retry-'));
    directories.push(directory);
    const state = new RemoteRequestStore(path.join(directory, 'remote-state-v2.json'));
    await state.load();
    await state.beginWorkspaceHandoff({
      channel: 'telegram',
      chatId: 'chat',
      sourceWorkspaceId: 'source',
      targetWorkspaceId: 'workspace',
      targetAlias: 'here',
    });
    const channel = new FailsOnceChannel('telegram');
    const host = {
      status: () => ({ conversations: [], requestChains: [], streamingConversationIds: [] }),
      createConversation: vi.fn(async () => ({
        id: 'created',
        title: 'Remote',
        activeModel: null,
        archived: false,
      })),
      addApprovalSink: () => ({ dispose: vi.fn() }),
      addQuestionSink: () => ({ dispose: vi.fn() }),
    } as unknown as ForgeHostFacade;
    const secrets = {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
      onDidChange: vi.fn(),
    } as unknown as vscode.SecretStorage;
    const runtime = new RemoteRuntime({
      storageDirectory: directory,
      workspaceRoot: directory,
      workspaceId: 'workspace',
      host,
      secrets,
      channelFactories: { telegram: () => channel },
      notifyLocal: vi.fn(),
    });
    const config = ForgeConfigSchema.parse({
      models: [{ name: 'model', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      remote: { enabled: true, telegram: { enabled: true } },
    });
    try {
      await runtime.applyConfig(config).catch(() => undefined);
      await vi.waitFor(() => expect(channel.starts).toBe(2), { timeout: 7_000, interval: 25 });
      expect(channel.starts).toBe(2);
      expect(channel.sent.some((message) => message.text.startsWith('Forge: now in here'))).toBe(
        true,
      );
      const reader = new RemoteRequestStore(path.join(directory, 'remote-state-v2.json'));
      await reader.load();
      expect(reader.binding('telegram', 'chat')?.workspaceId).toBe('workspace');
      expect(reader.hasPendingWorkspaceHandoff('workspace')).toBe(false);
    } finally {
      await runtime.dispose();
    }
  }, 15_000);
});
