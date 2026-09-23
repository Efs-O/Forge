import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import {
  announceWorkspaceArrivals,
  resumeWorkspaceHandoffs,
  workspaceIdFor,
} from '../../src/remote/RemoteWorkspaceHandoff';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

describe('workspaceIdFor', () => {
  it.runIf(process.platform === 'win32')(
    'treats Windows path casing as one workspace identity',
    () => {
      const actual = realpathSync.native(process.cwd());
      const alternateCase = actual
        .split('')
        .map((char) => (char >= 'a' && char <= 'z' ? char.toUpperCase() : char.toLowerCase()))
        .join('');
      expect(workspaceIdFor(actual)).toBe(workspaceIdFor(alternateCase));
    },
  );

  it.runIf(process.platform === 'win32')(
    'preserves the existing VS Code lowercase-drive workspace identity',
    () => {
      const actual = realpathSync
        .native(process.cwd())
        .replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
      const legacyId = createHash('sha256').update(actual).digest('hex');
      expect(workspaceIdFor(actual)).toBe(legacyId);
    },
  );

  it.runIf(process.platform !== 'win32')('preserves POSIX path casing in the identity', () => {
    expect(workspaceIdFor('/workspace/Forge')).not.toBe(workspaceIdFor('/workspace/forge'));
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function storeWithPendingHandoff(targetWorkspaceId: string): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-arrival-'));
  tempDirs.push(directory);
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  await store.beginWorkspaceHandoff({
    channel: 'fake',
    chatId: 'chat',
    sourceWorkspaceId: 'source',
    targetWorkspaceId,
    targetAlias: 'qwen',
  });
  return store;
}

/** A host holding `conversations`, whose restore/create the tests observe. */
function arrivalHost(conversations: Array<{ id: string; title: string; updatedAt: number }>) {
  const restoreConversation = vi.fn(async (id: string) => {
    const found = conversations.find((item) => item.id === id);
    if (!found) throw new Error('Forge: conversation could not be restored.');
    return { ...found, activeModel: null, archived: false };
  });
  const createConversation = vi.fn(async () => ({
    id: 'created',
    title: 'Untitled chat',
    activeModel: null,
    archived: false,
    updatedAt: 0,
  }));
  const host = {
    status: () => ({
      conversations,
      requestChains: [],
      streamingConversationIds: [],
      pendingApproval: undefined,
    }),
    restoreConversation,
    createConversation,
  } as unknown as ForgeHostFacade;
  return { host, restoreConversation, createConversation };
}

/**
 * Arriving in a workspace used to bind a BRAND NEW chat whatever was there, so
 * `/workspace 27` -- "go to 27 and carry on" -- landed in an empty chat and
 * cost a `/chats` plus a `/chat 1` to undo. The work you switched in order to
 * continue was one command further away than before you left.
 */
describe('workspace arrival', () => {
  it('continues the workspace newest conversation instead of creating one', async () => {
    const store = await storeWithPendingHandoff('target');
    const { host, restoreConversation, createConversation } = arrivalHost([
      { id: 'older', title: 'Older work', updatedAt: 10 },
      { id: 'newest', title: 'Game build', updatedAt: 99 },
    ]);

    const arrivals = await resumeWorkspaceHandoffs(store, 'target', host);

    expect(restoreConversation).toHaveBeenCalledWith('newest', { activate: false });
    expect(createConversation).not.toHaveBeenCalled();
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({ conversationTitle: 'Game build', created: false });
    expect(store.binding('fake', 'chat')?.conversationId).toBe('newest');
  });

  it('creates a chat only when the workspace has no history at all', async () => {
    const store = await storeWithPendingHandoff('target');
    const { host, createConversation } = arrivalHost([]);

    const arrivals = await resumeWorkspaceHandoffs(store, 'target', host);

    expect(createConversation).toHaveBeenCalled();
    expect(arrivals[0]).toMatchObject({ created: true });
    expect(store.binding('fake', 'chat')?.conversationId).toBe('created');
  });

  it('falls back to a new chat when the newest one cannot be reopened', async () => {
    const store = await storeWithPendingHandoff('target');
    const { host, createConversation } = arrivalHost([
      { id: 'newest', title: 'Game build', updatedAt: 99 },
    ]);
    // restoreConversation throws on the MAX_CONVERSATIONS cap. A full tab bar
    // must not turn an arrival into a chat bound to nothing.
    (host as unknown as { restoreConversation: () => Promise<never> }).restoreConversation =
      async () => {
        throw new Error('Forge: maximum open conversations reached.');
      };

    const arrivals = await resumeWorkspaceHandoffs(store, 'target', host);

    expect(createConversation).toHaveBeenCalled();
    expect(arrivals[0]).toMatchObject({ created: true });
  });

  it('names the conversation it landed in, so the receipt is checkable', async () => {
    const store = await storeWithPendingHandoff('target');
    const { host } = arrivalHost([{ id: 'newest', title: 'Game build', updatedAt: 99 }]);
    const arrivals = await resumeWorkspaceHandoffs(store, 'target', host);
    const channel = new FakeRemoteChannel();

    await announceWorkspaceArrivals(arrivals, {
      channelFor: () => channel,
      displayNameFor: () => 'Qwen testing',
      totpEnrolled: async () => false,
      notifyLocal: () => undefined,
    });

    // "a new chat is bound here" was sent whatever it bound, so a resumed
    // conversation was indistinguishable from a blank one without /view.
    expect(channel.sent[0]?.text).toContain('now in Qwen testing');
    expect(channel.sent[0]?.text).toContain('Game build');
    expect(channel.sent[0]?.text).not.toContain('a new chat is bound');
  });

  it('still says the session is locked when the arriving chat needs a code', async () => {
    const store = await storeWithPendingHandoff('target');
    const { host } = arrivalHost([]);
    const arrivals = await resumeWorkspaceHandoffs(store, 'target', host);
    const channel = new FakeRemoteChannel();

    await announceWorkspaceArrivals(arrivals, {
      channelFor: () => channel,
      displayNameFor: () => 'Qwen testing',
      totpEnrolled: async () => true,
      notifyLocal: () => undefined,
    });

    expect(channel.sent[0]?.text).toContain('nothing was here to continue');
    expect(channel.sent[0]?.text).toContain('6-digit code');
  });

  // At the conversation cap with nothing evictable, the create throws. That
  // used to escape after the claim: the handoff never completed, the rest of
  // the batch was dropped, and at startup the transports never came up.
  it('completes a handoff that cannot open a chat, keeps the batch going, and says why', async () => {
    const store = await storeWithPendingHandoff('target');
    await store.beginWorkspaceHandoff({
      channel: 'fake',
      chatId: 'second',
      sourceWorkspaceId: 'source',
      targetWorkspaceId: 'target',
      targetAlias: 'qwen',
    });
    const { host, createConversation } = arrivalHost([]);
    createConversation.mockRejectedValueOnce(new Error('Forge: all 10 open chats are busy.'));

    const arrivals = await resumeWorkspaceHandoffs(store, 'target', host);

    expect(arrivals).toHaveLength(2);
    expect(arrivals.filter((arrival) => arrival.failure)).toHaveLength(1);
    const failed = arrivals.find((arrival) => arrival.failure)!;
    expect(store.binding('fake', failed.handoff.chatId)).toBeUndefined();
    const bound = arrivals.find((arrival) => !arrival.failure)!;
    expect(store.binding('fake', bound.handoff.chatId)?.conversationId).toBe('created');
    expect(await resumeWorkspaceHandoffs(store, 'target', host)).toEqual([]);

    const channel = new FakeRemoteChannel();
    await announceWorkspaceArrivals([failed], {
      channelFor: () => channel,
      displayNameFor: () => 'Qwen testing',
      totpEnrolled: async () => false,
      notifyLocal: () => undefined,
    });
    expect(channel.sent[0]?.text).toContain('all 10 open chats are busy');
    expect(channel.sent[0]?.text).toContain('/chats');
  });
});
