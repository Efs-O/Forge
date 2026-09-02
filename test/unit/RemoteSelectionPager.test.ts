import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { handleRemoteCommand } from '../../src/remote/RemoteCommandHandler';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import {
  handleRemoteSelectionAction,
  sendConversationSelection,
  sendModelSelection,
  type RemoteSelectionContext,
} from '../../src/remote/RemoteSelectionPager';
import { generateTotp } from '../../src/remote/RemoteTotp';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function requestStore(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-selection-test-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

function textEvent(text: string): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'fake',
    kind: 'text',
    providerMessageId: `message-${text}`,
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 1,
    text,
  };
}

function selectionEvent(
  token: string,
  overrides: Partial<Extract<RemoteInboundEvent, { kind: 'selection' }>> = {},
): Extract<RemoteInboundEvent, { kind: 'selection' }> {
  return {
    channel: 'fake',
    kind: 'selection',
    providerMessageId: 'selection-action',
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 2,
    selectionKind: 'conversations',
    selectionToken: token,
    action: 'show',
    page: 1,
    messageId: '42',
    ...overrides,
  };
}

function hostWithConversations(count: number): ForgeHostFacade {
  const conversations = Array.from({ length: count }, (_, index) => ({
    id: `conversation-${index + 1}`,
    title: `Conversation ${index + 1}`,
    activeModel: `model-${(index % 3) + 1}`,
    archived: index === count - 1,
    updatedAt: count - index,
  }));
  return {
    status: () => ({
      conversations,
      requestChains: [],
      streamingConversationIds: [],
      pendingApproval: undefined,
    }),
    addApprovalSink: () => ({ dispose: () => undefined }),
    addQuestionSink: () => ({ dispose: () => undefined }),
  } as unknown as ForgeHostFacade;
}

function context(
  channel: FakeRemoteChannel,
  store: RemoteRequestStore,
  conversationCount: number,
  modelCount = 0,
): RemoteSelectionContext {
  return {
    channel,
    store,
    host: hostWithConversations(conversationCount),
    signal: new AbortController().signal,
    modelNames: Array.from({ length: modelCount }, (_, index) => `model-${index + 1}`),
    workspaceAliases: {},
  };
}

describe('remote selection pagination', () => {
  it('pages conversations in tens, preserves absolute selection, and closes', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = context(channel, store, 23);

    await expect(sendConversationSelection(textEvent('/list'), ctx)).resolves.toEqual({
      kind: 'handled',
    });
    const first = channel.selectionPageSends[0]!;
    expect(first.text).toContain('Forge conversations 1-10 of 23 · page 1/3');
    expect(first.text).toContain('10. Conversation 10');
    expect(first.text).not.toContain('11. Conversation 11');
    expect(first.controls).toMatchObject({
      kind: 'conversations',
      page: 0,
      pageCount: 3,
    });
    expect(first.controls.token).toMatch(/^[A-Za-z0-9_-]{12}$/);

    const stored = store.selection('fake', 'chat', 'conversations', first.controls.token);
    expect(stored?.values).toHaveLength(23);
    expect(stored?.values[16]).toBe('conversation-17');

    await expect(
      handleRemoteSelectionAction(selectionEvent(first.controls.token), ctx, 'show-page-two'),
    ).resolves.toEqual({ kind: 'handled' });
    const second = channel.selectionEdits[0]!;
    expect(second.messageId).toBe('42');
    expect(second.text).toContain('Forge conversations 11-20 of 23 · page 2/3');
    expect(second.text).toContain('11. Conversation 11');
    expect(second.text).not.toContain('21. Conversation 21');

    const restoreConversation = vi.fn(async (id: string) => ({
      id,
      title: 'Restored',
      activeModel: 'model-1',
      archived: false,
    }));
    (
      ctx.host as unknown as { restoreConversation: typeof restoreConversation }
    ).restoreConversation = restoreConversation;
    await handleRemoteCommand(
      textEvent('/resume 17'),
      {
        ...ctx,
        workspaceId: 'workspace',
        inactivityTimeoutMinutes: 30,
      },
      'resume-seventeen',
    );
    expect(restoreConversation).toHaveBeenCalledWith('conversation-17', { activate: false });

    await expect(
      handleRemoteSelectionAction(
        selectionEvent(first.controls.token, {
          providerMessageId: 'close-action',
          action: 'close',
          page: undefined,
        }),
        ctx,
        'close-list',
      ),
    ).resolves.toEqual({ kind: 'handled' });
    expect(channel.selectionCloses).toEqual([{ chatId: 'chat', messageId: '42' }]);
    expect(store.selection('fake', 'chat', 'conversations', first.controls.token)).toBeUndefined();
  });

  // Both verbs take a number that only a list can supply, so the bare form used
  // to fall past every branch in handleRemoteCommand to its catch-all and
  // answer "unknown command" - the one thing that was never true about them.
  it('answers a bare /resume and /model with the list the number comes from', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = {
      ...context(channel, store, 3, 2),
      workspaceId: 'workspace',
      inactivityTimeoutMinutes: 30,
    };

    await expect(handleRemoteCommand(textEvent('/resume'), ctx, 'bare-resume')).resolves.toEqual({
      kind: 'handled',
    });
    expect(channel.selectionPageSends[0]!.controls).toMatchObject({ kind: 'conversations' });

    await expect(handleRemoteCommand(textEvent('/model'), ctx, 'bare-model')).resolves.toEqual({
      kind: 'handled',
    });
    expect(channel.selectionPageSends[1]!.controls).toMatchObject({ kind: 'models' });
  });

  it('applies the same paging to models and supports explicit page commands', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = context(channel, store, 0, 25);

    await expect(sendModelSelection(textEvent('/models 2'), ctx, '2')).resolves.toEqual({
      kind: 'handled',
    });
    const page = channel.selectionPageSends[0]!;
    expect(page.text).toContain('Forge models 11-20 of 25 · page 2/3');
    expect(page.text).toContain('11. model-11');
    expect(page.text).not.toContain('21. model-21');
    expect(store.selection('fake', 'chat', 'models')?.values[16]).toBe('model-17');

    await store.setBinding({
      channel: 'fake',
      chatId: 'chat',
      workspaceId: 'workspace',
      conversationId: 'conversation-1',
    });
    const setConversationModel = vi.fn(async () => undefined);
    (
      ctx.host as unknown as { setConversationModel: typeof setConversationModel }
    ).setConversationModel = setConversationModel;
    await handleRemoteCommand(
      textEvent('/model 17'),
      {
        ...ctx,
        workspaceId: 'workspace',
        inactivityTimeoutMinutes: 30,
      },
      'model-seventeen',
    );
    expect(setConversationModel).toHaveBeenCalledWith('conversation-1', 'model-17');

    await expect(sendModelSelection(textEvent('/models 4'), ctx, '4')).resolves.toEqual({
      kind: 'rejected',
      reason: 'usage: /models <page 1-3>',
    });
    expect(channel.selectionPageSends).toHaveLength(1);
  });

  it('rejects stale tokens and out-of-range callback pages', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = context(channel, store, 12);
    await sendConversationSelection(textEvent('/list'), ctx);
    const token = channel.selectionPageSends[0]!.controls.token;

    await expect(
      handleRemoteSelectionAction(selectionEvent('abcdefghijkl'), ctx, 'stale'),
    ).resolves.toMatchObject({ kind: 'rejected', reason: expect.stringContaining('expired') });
    await expect(
      handleRemoteSelectionAction(selectionEvent(token, { page: 2 }), ctx, 'out-of-range'),
    ).resolves.toEqual({ kind: 'rejected', reason: 'selection page is out of range' });
    expect(channel.selectionEdits).toHaveLength(0);
  });

  it('routes navigation through paired-owner authorization', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner');
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const secret = await auth.createTotpEnrollmentSecret('fake');
    const now = Date.now();
    const code = generateTotp(secret, now).code;
    await auth.confirmTotpEnrollment('fake', secret, code, now);
    const controller = new RemoteController(channel, store, auth, hostWithConversations(1), {
      workspaceId: 'workspace',
      queueLimit: 5,
      maxMessageChars: 4_000,
      rateLimitPerMinute: 30,
      modelNames: Array.from({ length: 12 }, (_, index) => `model-${index + 1}`),
      attachmentsEnabled: false,
      acceptPdfAttachments: true,
      workspaceAliases: {},
    });
    await controller.start();
    try {
      await expect(channel.emit(textEvent('/models'))).resolves.toEqual({ kind: 'handled' });
      expect(channel.selectionPageSends).toHaveLength(0);
      expect(channel.sent.at(-1)?.text).toContain('authentication required');
      await expect(
        channel.emit({ ...textEvent(code), providerMessageId: 'authenticate' }),
      ).resolves.toEqual({ kind: 'handled' });
      await expect(
        channel.emit({ ...textEvent('/models'), providerMessageId: 'models-after-auth' }),
      ).resolves.toEqual({ kind: 'handled' });
      const token = channel.selectionPageSends[0]!.controls.token;
      await expect(
        channel.emit(
          selectionEvent(token, {
            senderId: 'intruder',
            selectionKind: 'models',
          }),
        ),
      ).resolves.toEqual({ kind: 'rejected', reason: 'sender is not paired' });
      await expect(
        channel.emit(
          selectionEvent(token, {
            selectionKind: 'models',
          }),
        ),
      ).resolves.toEqual({ kind: 'handled' });
      expect(channel.selectionEdits[0]?.text).toContain('Forge models 11-12 of 12');
    } finally {
      await controller.stop();
    }
  });

  // RemoteRuntime computes currentWorkspaceAlias and RemoteCommandHandler reads
  // it, but the controller passed it only to the selection context: the marker
  // and the "you are already here" guard were both dead until this ran.
  it('gives the command path the alias this window is actually in', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner');
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const secret = await auth.createTotpEnrollmentSecret('fake');
    const code = generateTotp(secret, Date.now()).code;
    await auth.confirmTotpEnrollment('fake', secret, code, Date.now());
    const switchWorkspace = vi.fn(async () => undefined);
    const controller = new RemoteController(channel, store, auth, hostWithConversations(1), {
      workspaceId: 'workspace',
      queueLimit: 5,
      maxMessageChars: 4_000,
      rateLimitPerMinute: 30,
      modelNames: [],
      attachmentsEnabled: false,
      acceptPdfAttachments: true,
      workspaceAliases: { forge: 'Forge', qwen: 'Qwen Testing' },
      currentWorkspaceAlias: 'forge',
      switchWorkspace,
    });
    await controller.start();
    try {
      await channel.emit({ ...textEvent(code), providerMessageId: 'authenticate' });

      await expect(channel.emit(textEvent('/workspace list'))).resolves.toEqual({
        kind: 'handled',
      });
      expect(channel.selectionPageSends[0]?.text).toContain('1. forge — Forge · current');

      await expect(channel.emit(textEvent('/new 1'))).resolves.toEqual({
        kind: 'rejected',
        reason: 'this chat is already in Forge; /new alone starts a chat here',
      });
      expect(switchWorkspace).not.toHaveBeenCalled();

      await expect(channel.emit(textEvent('/new 2'))).resolves.toEqual({ kind: 'handled' });
      expect(switchWorkspace).toHaveBeenCalledWith('qwen', 'fake', 'chat');
    } finally {
      await controller.stop();
    }
  });
});

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
