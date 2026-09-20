import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { setMeshOrchestrator } from '../../src/agentMesh/meshContext';
import type { MeshOrchestrator } from '../../src/agentMesh/meshOrchestrator';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { handleRemoteSessionCommand } from '../../src/remote/RemoteSessionCommands';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import type { RemoteInboundEvent } from '../../src/remote/types';

const tempDirs: string[] = [];

afterEach(async () => {
  setMeshOrchestrator(undefined);
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('Telegram agent-bus queue visibility (F-09)', () => {
  it('renders pending bus messages with an alias and first line', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mesh-queue-'));
    tempDirs.push(directory);
    const store = new RemoteRequestStore(path.join(directory, 'state.json'));
    await store.load();
    await store.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'conversation',
    });
    setMeshOrchestrator(
      {
        pendingMessages: () => [
          { alias: 'codex', message: 'inspect <thing>\nthen summarize the result' },
        ],
      } as unknown as MeshOrchestrator,
    );

    const channel = new FakeRemoteChannel();
    const context = {
      channel,
      store,
      signal: new AbortController().signal,
    } as unknown as RemoteCommandContext;
    const event = {
      channel: 'fake',
      kind: 'text',
      providerMessageId: 'queue-1',
      senderId: 'owner',
      chatId: 'chat-a',
      chatType: 'private',
      receivedAt: 1,
      text: '/queue',
    } as RemoteInboundEvent;

    await handleRemoteSessionCommand(
      '/queue',
      undefined,
      event as Extract<RemoteInboundEvent, { kind: 'text' }>,
      context,
    );

    expect(channel.sent.at(-1)?.text).toContain('agent-bus codex: inspect <thing>');
    expect(channel.sent.at(-1)?.text).not.toContain('then summarize the result');
    expect(channel.sent.at(-1)?.text).toContain('shown for visibility');
  });
});
