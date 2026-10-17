import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { handleRemoteCommand } from '../../src/remote/RemoteCommandHandler';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const newEvent: Extract<RemoteInboundEvent, { kind: 'text' }> = {
  channel: 'fake',
  kind: 'text',
  providerMessageId: 'message-new',
  senderId: 'owner',
  chatId: 'chat',
  chatType: 'private',
  receivedAt: 1,
  text: '/new',
};

describe('/new redelivery (U08-04)', () => {
  it('a failed ack does not make the redelivered /new create a second chat', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-new-'));
    tempDirs.push(directory);
    const store = new RemoteRequestStore(path.join(directory, 'state.json'));
    await store.load();
    const channel = new FakeRemoteChannel();
    let created = 0;
    const createConversation = vi.fn(async () => ({ id: `conversation-${++created}` }));
    const context = {
      channel,
      store,
      host: { createConversation } as unknown as ForgeHostFacade,
      workspaceId: 'ws',
      signal: new AbortController().signal,
      inactivityTimeoutMinutes: 30,
      rateLimitPerMinute: 30,
      modelEntries: [],
      workspaceAliases: {},
    };

    channel.sendError = 'telegram timed out';
    await expect(handleRemoteCommand(newEvent, context, 'new-1')).rejects.toThrow(
      'telegram timed out',
    );
    channel.sendError = undefined;
    await expect(handleRemoteCommand(newEvent, context, 'new-1')).resolves.toEqual({
      kind: 'handled',
    });

    expect(createConversation).toHaveBeenCalledOnce();
    expect(store.binding('fake', 'chat')?.conversationId).toBe('conversation-1');
  });
});
