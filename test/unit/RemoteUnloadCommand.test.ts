import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

function text(body: string, id: string): RemoteInboundEvent {
  return {
    channel: 'fake',
    kind: 'text',
    providerMessageId: id,
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 1,
    text: body,
  };
}

async function start(bound: boolean) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-unload-'));
  tempDirs.push(directory);
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  if (bound) {
    await store.setBinding({
      channel: 'fake',
      chatId: 'chat',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
  }
  const values = new Map([['forge.remote.fake.ownerId', 'owner']]);
  const secrets = {
    get: (key: string) => Promise.resolve(values.get(key)),
    store: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
  const host = {
    addApprovalSink: () => ({ dispose: () => undefined }),
    addQuestionSink: () => ({ dispose: () => undefined }),
    answerQuestion: () => false,
    status: () => ({
      activeConversationId: 'c1',
      conversations: [],
      requestChains: [],
      streamingConversationIds: [],
    }),
    unloadModels: vi.fn(async () => undefined),
    unloadConversationModel: vi.fn(async () => ({ model: 'qwen-q6', wasLoaded: true })),
  } as unknown as ForgeHostFacade;
  const channel = new FakeRemoteChannel();
  const controller = new RemoteController(
    channel,
    store,
    new RemoteAuth(secrets as unknown as vscode.SecretStorage),
    host,
    { workspaceId: 'workspace', queueLimit: 5, maxMessageChars: 1000, rateLimitPerMinute: 30 },
  );
  await controller.start();
  return { channel, host, controller };
}

describe('remote /unload vs /unloadall', () => {
  it("/unload releases only the bound conversation's model", async () => {
    const { channel, host, controller } = await start(true);

    await expect(channel.emit(text('/unload', 'u1'))).resolves.toEqual({ kind: 'handled' });

    expect(host.unloadConversationModel).toHaveBeenCalledWith('c1');
    expect(host.unloadModels).not.toHaveBeenCalled();
    expect(channel.sent.at(-1)?.text).toContain('qwen-q6 unloaded');
    await controller.stop();
  });

  it('/unload with no bound conversation refuses and names /unloadall', async () => {
    const { channel, host, controller } = await start(false);

    const result = await channel.emit(text('/unload', 'u2'));

    expect(result).toMatchObject({ kind: 'rejected' });
    expect(JSON.stringify(result)).toContain('/unloadall');
    expect(host.unloadConversationModel).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('/unloadall still releases every model', async () => {
    const { channel, host, controller } = await start(true);

    await expect(channel.emit(text('/unloadall', 'u3'))).resolves.toEqual({ kind: 'handled' });

    expect(host.unloadModels).toHaveBeenCalledTimes(1);
    expect(host.unloadConversationModel).not.toHaveBeenCalled();
    await controller.stop();
  });
});
