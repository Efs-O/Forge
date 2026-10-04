import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ForgeConfigSchema } from '../../src/config/schema';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { RemoteRuntime } from '../../src/remote/RemoteRuntime';
import type { RemoteBinding } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const temporaryDirectories: string[] = [];

class MemorySecrets {
  readonly values = new Map<string, string>();
  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
  onDidChange = vi.fn();
}

function host(): ForgeHostFacade {
  return {
    createConversation: vi.fn(async () => ({
      id: 'conversation',
      title: 'Established chat',
      activeModel: 'model',
      archived: false,
    })),
    restoreConversation: vi.fn(),
    send: vi.fn(async () => ({ kind: 'completed' as const, finalText: 'done' })),
    cancel: vi.fn(async () => undefined),
    queueIntent: vi.fn(),
    resolveApproval: vi.fn(),
    addApprovalSink: () => ({ dispose: () => undefined }),
    addQuestionSink: () => ({ dispose: () => undefined }),
    answerQuestion: () => false,
    status: () => ({
      activeConversationId: 'conversation',
      conversations: [],
      requestChains: [],
      streamingConversationIds: [],
    }),
    clankerMode: vi.fn(() => false),
    setClankerMode: vi.fn(),
    contextBudget: vi.fn(() => ({ used: 0, max: 0 })),
    compact: vi.fn(async () => 'compacted' as const),
  } as ForgeHostFacade;
}

async function runtimeFixture(
  bindings: RemoteBinding[] = [
    {
      channel: 'telegram',
      chatId: 'bound-chat',
      workspaceId: 'workspace',
      conversationId: 'conversation',
    },
  ],
  remoteEnabled = true,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-direct-file-'));
  temporaryDirectories.push(directory);
  const workspaceRoot = path.join(directory, 'workspace');
  await fs.mkdir(workspaceRoot);
  const file = path.join(workspaceRoot, 'plan.md');
  const bytes = Buffer.from('# approved plan\n\nExact bytes.\n');
  await fs.writeFile(file, bytes);

  const store = new RemoteRequestStore(path.join(directory, 'remote-state-v2.json'));
  await store.load();
  for (const binding of bindings) await store.setBinding(binding);

  const secrets = new MemorySecrets();
  secrets.values.set('forge.remote.telegram.ownerId', 'owner');
  const channel = new FakeRemoteChannel('telegram');
  const uploads: Array<{ chatId: string; bytes: Buffer; caption: string }> = [];
  const sendPhoto = channel.sendPhoto.bind(channel);
  channel.sendPhoto = async (chatId, filePath, caption) => {
    uploads.push({ chatId, bytes: await fs.readFile(filePath), caption });
    await sendPhoto(chatId, filePath, caption);
  };
  const facade = host();
  const runtime = new RemoteRuntime({
    storageDirectory: directory,
    workspaceRoot,
    workspaceId: 'workspace',
    host: facade,
    secrets: secrets as unknown as vscode.SecretStorage,
    channelFactories: { telegram: () => channel },
    notifyLocal: vi.fn(),
  });
  await runtime.applyConfig(
    ForgeConfigSchema.parse({
      models: [{ name: 'model', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      remote: { enabled: remoteEnabled, telegram: { enabled: true } },
    }),
  );
  return {
    directory,
    workspaceRoot,
    file,
    bytes,
    store,
    secrets,
    channel,
    uploads,
    facade,
    runtime,
    sendPhoto,
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('RemoteRuntime direct file delivery', () => {
  it('sends exact in-workspace file through the active Telegram transport and its lease', async () => {
    const { file, bytes, secrets, channel, uploads, facade, runtime, sendPhoto } =
      await runtimeFixture();
    try {
      await expect(
        runtime.sendFileToConversation('conversation', 'plan.md', 'approved'),
      ).resolves.toEqual({ kind: 'sent' });
      const realFile = await fs.realpath(file);
      expect(channel.photos).toEqual([
        { chatId: 'bound-chat', filePath: realFile, caption: 'approved' },
      ]);
      expect(uploads).toEqual([{ chatId: 'bound-chat', bytes, caption: 'approved' }]);
      expect(facade.send).not.toHaveBeenCalled();
      expect(facade.compact).not.toHaveBeenCalled();
      const failUncertainly = vi.fn(async () => {
        throw new Error('socket closed after upload');
      });
      channel.sendPhoto = failUncertainly;
      await expect(
        runtime.sendFileToConversation('conversation', 'plan.md', 'retry only on owner request'),
      ).resolves.toMatchObject({ kind: 'unknown', error: expect.stringContaining('No retry') });
      expect(failUncertainly).toHaveBeenCalledOnce();
      channel.sendPhoto = sendPhoto;
      secrets.values.delete('forge.remote.telegram.ownerId');
      await expect(
        runtime.sendFileToConversation('conversation', 'plan.md', 'expired authentication'),
      ).resolves.toMatchObject({ kind: 'refused' });
      secrets.values.set('forge.remote.telegram.ownerId', 'owner');
      await expect(
        runtime.sendFileToConversation('another-conversation', 'plan.md', ''),
      ).resolves.toMatchObject({ kind: 'refused' });

      expect(channel.photos).toHaveLength(1);
      expect(uploads).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it('refuses foreign, ambiguous, unauthenticated, and disabled delivery before upload', async () => {
    const bindings = [
      [
        {
          channel: 'telegram' as const,
          chatId: 'foreign-chat',
          workspaceId: 'another-workspace',
          conversationId: 'conversation',
        },
      ],
      [
        {
          channel: 'telegram' as const,
          chatId: 'first-chat',
          workspaceId: 'workspace',
          conversationId: 'conversation',
        },
        {
          channel: 'telegram' as const,
          chatId: 'second-chat',
          workspaceId: 'workspace',
          conversationId: 'conversation',
        },
      ],
    ];
    for (const set of bindings) {
      const fixture = await runtimeFixture(set);
      try {
        await expect(
          fixture.runtime.sendFileToConversation('conversation', 'plan.md', 'refused'),
        ).resolves.toMatchObject({ kind: 'refused' });
        expect(fixture.channel.photos).toHaveLength(0);
      } finally {
        await fixture.runtime.dispose();
      }
    }

    const unauthenticated = await runtimeFixture();
    try {
      unauthenticated.secrets.values.delete('forge.remote.telegram.ownerId');
      await expect(
        unauthenticated.runtime.sendFileToConversation('conversation', 'plan.md', 'refused'),
      ).resolves.toMatchObject({ kind: 'refused' });
      expect(unauthenticated.channel.photos).toHaveLength(0);
    } finally {
      await unauthenticated.runtime.dispose();
    }

    const disabled = await runtimeFixture(
      [
        {
          channel: 'telegram',
          chatId: 'bound-chat',
          workspaceId: 'workspace',
          conversationId: 'conversation',
        },
      ],
      false,
    );
    try {
      await expect(
        disabled.runtime.sendFileToConversation('conversation', 'plan.md', 'refused'),
      ).resolves.toMatchObject({ kind: 'refused' });
      expect(disabled.channel.photos).toHaveLength(0);
    } finally {
      await disabled.runtime.dispose();
    }
  });
});
