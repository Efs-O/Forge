import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { MemorySecrets } from '../support/memorySecrets';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteControllerOptions } from '../../src/remote/remoteControllerOptions';
import type { AgentProgressEvent } from '../../src/sidebar/AgentProgress';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-prompt-mirror-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

function options(): RemoteControllerOptions {
  return {
    workspaceId: 'workspace',
    queueLimit: 5,
    maxMessageChars: 3_900,
    rateLimitPerMinute: 30,
    modelEntries: [],
    attachmentsEnabled: false,
    acceptPdfAttachments: false,
    workspaceAliases: {},
    unlockBacklogMax: 5,
  };
}

function progressEvent(
  listener: ((event: AgentProgressEvent) => void) | undefined,
  event: AgentProgressEvent,
): void {
  listener?.(event);
}

describe('RemoteController.mirrorPrompt', () => {
  it('sends an unlocked prompt before its status and later answer', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-1',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const channel = new FakeRemoteChannel();
    const order: string[] = [];
    const sendProgress = channel.sendProgress.bind(channel);
    channel.sendProgress = async (...args: Parameters<FakeRemoteChannel['sendProgress']>) => {
      order.push(args[1]);
      return sendProgress(...args);
    };
    const send = channel.send.bind(channel);
    channel.send = async (...args: Parameters<FakeRemoteChannel['send']>) => {
      order.push(args[1]);
      return send(...args);
    };
    const promptChannel = channel as FakeRemoteChannel & {
      sendProgressPrompt: (chatId: string, text: string) => Promise<string>;
    };
    promptChannel.sendProgressPrompt = async (_chatId, text) => {
      order.push(text);
      return 'prompt-carrier';
    };
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner');
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    let listener: ((event: AgentProgressEvent) => void) | undefined;
    const host = {
      createConversation: async () => ({
        id: 'c1',
        title: 'Remote',
        activeModel: 'local',
        archived: false,
      }),
      restoreConversation: async () => undefined,
      send: async () => ({ kind: 'completed' as const, finalText: 'ok' }),
      cancel: async () => undefined,
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      setClankerMode: () => undefined,
      status: () => ({
        activeConversationId: 'c1',
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
      }),
      onAgentProgress: (next: (event: AgentProgressEvent) => void) => {
        listener = next;
        return { dispose: () => undefined };
      },
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(channel, state, auth, host, options());
    await controller.start();
    try {
      await controller.mirrorPrompt('c1', 'You (VS Code): run the checks');
      progressEvent(listener, { conversationId: 'c1', kind: 'status', text: 'Running tests…' });
      await vi.waitFor(() => expect(order).toEqual([
        'You (VS Code): run the checks',
        'Forge: working…',
      ]));
      progressEvent(listener, { conversationId: 'c1', kind: 'end', ok: true });
      await controller.mirrorTurn('c1', 'The checks passed.');
      await vi.waitFor(() => expect(order.at(-1)).toBe('The checks passed.'));
      expect(order).toEqual([
        'You (VS Code): run the checks',
        'Forge: working…',
        'The checks passed.',
      ]);
    } finally {
      await controller.stop();
    }
  });

  it('uses the mirror predicate and holds a locked prompt before the later answer', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-1',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-2',
      workspaceId: 'workspace',
      conversationId: 'c2',
    });
    const channel = new FakeRemoteChannel();
    const secrets = new MemorySecrets();
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    let listener: ((event: AgentProgressEvent) => void) | undefined;
    const host = {
      createConversation: async () => ({
        id: 'c1',
        title: 'Remote',
        activeModel: 'local',
        archived: false,
      }),
      restoreConversation: async () => undefined,
      send: async () => ({ kind: 'completed' as const, finalText: 'ok' }),
      cancel: async () => undefined,
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      setClankerMode: () => undefined,
      status: () => ({
        activeConversationId: 'c1',
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
      }),
      onAgentProgress: (next: (event: AgentProgressEvent) => void) => {
        listener = next;
        return { dispose: () => undefined };
      },
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(channel, state, auth, host, options());
    await controller.start();
    try {
      controller.setNotify('chat-1', false);
      await expect(controller.mirrorPrompt('c1', 'muted')).resolves.toBe(0);
      controller.setNotify('chat-1', true);
      controller.setMirror('chat-1', false);
      await expect(controller.mirrorPrompt('c1', 'unmirrored')).resolves.toBe(0);
      controller.setMirror('chat-1', true);
      controller.suppressAgentOriginProgress('c2');
      await expect(controller.mirrorPrompt('c2', 'agent-origin')).resolves.toBe(0);

      await expect(controller.mirrorPrompt('c1', 'You (VS Code): inspect the change')).resolves.toBe(1);
      progressEvent(listener, { conversationId: 'c1', kind: 'status', text: 'Running tests…' });
      progressEvent(listener, { conversationId: 'c1', kind: 'end', ok: true });
      await vi.waitFor(() => expect(state.pendingOutbox('fake')).toHaveLength(1));
      await controller.mirrorTurn('c1', 'Here is the answer.');

      expect(channel.progress).toEqual([]);
      expect(state.pendingOutbox('fake').map((item) => item.text)).toEqual([
        'You (VS Code): inspect the change',
        'Here is the answer.',
      ]);
    } finally {
      await controller.stop();
    }
  });
});
