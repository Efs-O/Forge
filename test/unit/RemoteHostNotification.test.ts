import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteControllerOptions } from '../../src/remote/remoteControllerOptions';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

/**
 * enqueueHostNotification's return value is what notify_user reports to the
 * model, so these tests are about the count as much as the delivery: a wrong
 * number here becomes the agent telling the user it reached their phone.
 */
async function rig(
  chatIds: readonly string[] = ['chat-1'],
  options: Partial<RemoteControllerOptions> = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-notify-'));
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  for (const chatId of chatIds) {
    await store.setBinding({
      channel: 'fake',
      chatId,
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
  }
  const secrets = {
    values: new Map<string, string>([['forge.remote.fake.ownerId', 'owner-1']]),
    get(key: string) {
      return Promise.resolve(this.values.get(key));
    },
    store(key: string, value: string) {
      this.values.set(key, value);
      return Promise.resolve();
    },
    delete(key: string) {
      this.values.delete(key);
      return Promise.resolve();
    },
    onDidChange: () => ({ dispose: () => undefined }),
  };
  const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
  const channel = new FakeRemoteChannel();
  const host = {
    createConversation: vi.fn(),
    restoreConversation: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(async () => undefined),
    queueIntent: vi.fn(),
    resolveApproval: vi.fn(),
    addApprovalSink: () => ({ dispose: () => undefined }),
    addQuestionSink: () => ({ dispose: () => undefined }),
    answerQuestion: vi.fn(),
    status: () => ({
      activeConversationId: 'c1',
      conversations: [],
      requestChains: [],
      streamingConversationIds: [],
    }),
    clankerMode: vi.fn(() => false),
    setClankerMode: vi.fn(),
    contextBudget: vi.fn(() => ({ used: 1, max: 2 })),
    compact: vi.fn(),
  } as unknown as ForgeHostFacade;
  const controller = new RemoteController(channel, store, auth, host, {
    workspaceId: 'workspace',
    queueLimit: 5,
    maxMessageChars: 4_000,
    rateLimitPerMinute: 60,
    ...options,
  });
  await controller.start();
  return {
    controller,
    store,
    channel,
    cleanup: async () => {
      await controller.stop();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

describe('RemoteController.enqueueHostNotification', () => {
  it('returns how many bound chats it queued to, and queues to each', async () => {
    const { controller, store, cleanup } = await rig(['chat-1', 'chat-2']);
    try {
      expect(await controller.enqueueHostNotification('c1', 'build done')).toBe(2);
      const queued = store.pendingOutbox('fake');
      expect(queued.map((item) => item.chatId).sort()).toEqual(['chat-1', 'chat-2']);
    } finally {
      await cleanup();
    }
  });

  // A silent zero is the whole point: it is what stops the agent claiming it
  // notified a user whose phone never buzzed.
  it('returns zero when the conversation is bound to nothing', async () => {
    const { controller, cleanup } = await rig();
    try {
      expect(await controller.enqueueHostNotification('unbound', 'build done')).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('skips a muted chat and drops it from the count', async () => {
    const { controller, store, cleanup } = await rig(['chat-1', 'chat-2']);
    try {
      controller.setNotify('chat-1', false);
      expect(controller.isNotifyOn('chat-1')).toBe(false);
      expect(controller.isNotifyOn('chat-2')).toBe(true);
      expect(await controller.enqueueHostNotification('c1', 'build done')).toBe(1);
      expect(store.pendingOutbox('fake').map((item) => item.chatId)).toEqual(['chat-2']);
    } finally {
      await cleanup();
    }
  });

  it('reports zero once every bound chat is muted', async () => {
    const { controller, store, cleanup } = await rig(['chat-1']);
    try {
      controller.setNotify('chat-1', false);
      expect(await controller.enqueueHostNotification('c1', 'build done')).toBe(0);
      expect(store.pendingOutbox('fake')).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('unmutes again on /notify on', async () => {
    const { controller, cleanup } = await rig(['chat-1']);
    try {
      controller.setNotify('chat-1', false);
      controller.setNotify('chat-1', true);
      expect(await controller.enqueueHostNotification('c1', 'build done')).toBe(1);
    } finally {
      await cleanup();
    }
  });
});

// The other half of the delivery seam: `deliverHostImage` must reach the
// progress channel of the turn that is actually watching, and report 0 when no
// turn is open. `RemoteHostSubscriptions.test.ts` pins the routing decision
// (imagePath -> deliverHostImage); this pins what the controller then does with
// it, which a mocked controller cannot show.
describe('RemoteController.deliverHostImage', () => {
  it('delivers to the chat watching the turn', async () => {
    const { controller, channel, cleanup } = await rig(['chat-1']);
    try {
      // Open the turn the way the queue drain does: a progress message whose id
      // becomes the message the send rides behind.
      controller['progress'].begin('c1', 'chat-1', 'progress-1');
      expect(controller.deliverHostImage('c1', 'C:/img/fox.jpg', 'fox')).toBe(1);
      await vi.waitFor(() =>
        expect(channel.photos).toEqual([
          { chatId: 'chat-1', filePath: 'C:/img/fox.jpg', caption: 'fox' },
        ]),
      );
    } finally {
      await cleanup();
    }
  });

  it('reports 0 when no chat is watching the conversation', async () => {
    const { controller, channel, cleanup } = await rig(['chat-1']);
    try {
      expect(controller.deliverHostImage('c1', 'C:/img/fox.jpg', 'fox')).toBe(0);
      expect(channel.photos).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

// The full chain: broadcast -> durable outbox -> delivery -> armed delete.
// Each link is tested in isolation elsewhere; this is the glue, where a
// positional constructor argument could silently land in the wrong slot.
describe('RemoteController.broadcastHostNotification (ephemeral)', () => {
  it('deletes an ephemeral host notification after the reply delay', async () => {
    const { controller, channel, cleanup } = await rig(['chat-1'], {
      deleteCommandRepliesAfter: 1,
    });
    try {
      expect(await controller.broadcastHostNotification('Forge: all models unloaded.', true)).toBe(
        1,
      );
      await vi.waitFor(
        () => expect(channel.sent.at(-1)?.text).toBe('Forge: all models unloaded.'),
        { timeout: 2_000 },
      );
      await vi.waitFor(
        () =>
          expect(channel.deleted).toContainEqual({ chatId: 'chat-1', messageId: 'sent-1' }),
        { timeout: 3_000 },
      );
    } finally {
      await cleanup();
    }
  });

  it('keeps a plain host notification even after the reply delay', async () => {
    const { controller, channel, cleanup } = await rig(['chat-1'], {
      deleteCommandRepliesAfter: 1,
    });
    try {
      expect(await controller.broadcastHostNotification('Forge: backend restarted.')).toBe(1);
      await vi.waitFor(
        () => expect(channel.sent.at(-1)?.text).toBe('Forge: backend restarted.'),
        { timeout: 2_000 },
      );
      // Past the 1 s reply delay: a non-ephemeral notification is never deleted.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(channel.deleted).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
