import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ForgeConfigSchema } from '../../src/config/schema';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteRuntime } from '../../src/remote/RemoteRuntime';
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
});
