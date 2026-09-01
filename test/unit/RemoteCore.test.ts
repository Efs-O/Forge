import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { handleRemoteCommand } from '../../src/remote/RemoteCommandHandler';
import { RemoteRequestStore, remoteDedupKey } from '../../src/remote/RemoteRequestStore';
import { RemoteLeaseError, RemoteTransportLease } from '../../src/remote/RemoteTransportLease';
import type { RemoteInboundEvent, RemoteRequestRecord } from '../../src/remote/types';
import type { CompactionOutcome } from '../../src/sidebar/CompactionService';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ToolApprovalSink } from '../../src/sidebar/ToolApprovalService';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-test-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

function request(overrides: Partial<RemoteRequestRecord> = {}): RemoteRequestRecord {
  return {
    id: 'r1',
    dedupKey: remoteDedupKey('fake', 'chat', 'message'),
    channel: 'fake',
    chatId: 'chat',
    providerMessageId: 'message',
    conversationId: 'c1',
    text: 'hello',
    receivedAt: 1,
    state: 'queued',
    updatedAt: 1,
    ...overrides,
  };
}

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

describe('RemoteRequestStore', () => {
  it('atomically persists terminal execution with a pending outbox item', async () => {
    const state = await store();
    await state.enqueue(request());
    await state.markRunning('r1');
    await state.finish('r1', 'completed', { finalText: 'done', notification: 'done' });
    expect(state.getRequest('r1')).toMatchObject({ state: 'completed', finalText: 'done' });
    expect(state.pendingOutbox()).toHaveLength(1);
  });

  it('turns crash-left running work unknown and sending notifications pending', async () => {
    const state = await store();
    await state.enqueue(request());
    await state.markRunning('r1');
    await state.finish('r1', 'completed', { notification: 'done' });
    const outbox = state.pendingOutbox()[0]!;
    await state.markOutbox(outbox.id, 'sending');
    await state.beginControlEvent('command-in-flight');

    const reloaded = new RemoteRequestStore(
      path.join(tempDirs[tempDirs.length - 1]!, 'state.json'),
    );
    await reloaded.load();
    expect(reloaded.pendingOutbox()).toHaveLength(1);
    await expect(reloaded.beginControlEvent('command-in-flight')).resolves.toBe('unknown');

    const running = request({ id: 'r2', dedupKey: 'r2', state: 'running' });
    await reloaded.enqueue(running);
    const secondReload = new RemoteRequestStore(
      path.join(tempDirs[tempDirs.length - 1]!, 'state.json'),
    );
    await secondReload.load();
    expect(secondReload.getRequest('r2')?.state).toBe('unknown');
  });

  it('prioritizes steering prompts and can durably cancel selected queued work', async () => {
    const state = await store();
    await state.enqueue(request({ id: 'normal', dedupKey: 'normal', admittedAt: 1 }));
    await state.enqueue(
      request({ id: 'steer', dedupKey: 'steer', admittedAt: 2, priority: 'steer' }),
    );

    expect(state.queued('c1').map((item) => item.id)).toEqual(['steer', 'normal']);
    await expect(state.cancelQueued('c1', new Set(['normal']))).resolves.toBe(1);
    expect(state.queued('c1').map((item) => item.id)).toEqual(['steer']);
    expect(state.getRequest('normal')?.state).toBe('cancelled');
  });
});

describe('remote configuration and lease', () => {
  it('is default-deny and validates bounded behavior-only settings', () => {
    const parsed = ForgeConfigSchema.parse({
      models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      remote: { enabled: true, telegram: { enabled: true } },
    });
    expect(parsed.remote).toEqual({
      enabled: true,
      queue_limit: 5,
      max_message_chars: 12_000,
      rate_limit_per_minute: 30,
      auth: { inactivity_timeout_minutes: 30 },
      attachments: { enabled: false, retain_days: 30, accept_pdf: true },
      workspace_aliases: {},
      telegram: { enabled: true },
      whatsapp: { enabled: false },
    });
    expect(
      ForgeConfigSchema.safeParse({
        models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
        remote: { enabled: true, queue_limit: 0 },
      }).success,
    ).toBe(false);
  });

  it('allows one fenced owner and releases only its token', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-lease-test-'));
    tempDirs.push(directory);
    const first = await RemoteTransportLease.acquire({
      directory,
      key: 'telegram-account',
      workspaceId: 'w1',
      instanceId: 'one',
      heartbeatMs: 60_000,
      onLost: vi.fn(),
    });
    await expect(
      RemoteTransportLease.acquire({
        directory,
        key: 'telegram-account',
        workspaceId: 'w2',
        instanceId: 'two',
        heartbeatMs: 60_000,
        onLost: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(RemoteLeaseError);
    expect(await first.verify()).toBe(true);
    await first.release();
    const second = await RemoteTransportLease.acquire({
      directory,
      key: 'telegram-account',
      workspaceId: 'w2',
      instanceId: 'two',
      heartbeatMs: 60_000,
      onLost: vi.fn(),
    });
    await second.release();
  });
});

describe('RemoteController with fake channel', () => {
  it('pairs privately, durably deduplicates, executes, and delivers the real final text', async () => {
    const state = await store();
    const secrets = new MemorySecrets();
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const channel = new FakeRemoteChannel();
    const send = vi.fn(async () => ({ kind: 'completed' as const, finalText: 'real answer' }));
    const host = {
      createConversation: vi.fn(async () => ({
        id: 'c1',
        title: 'Remote',
        activeModel: 'local',
        archived: false,
      })),
      restoreConversation: vi.fn(),
      send,
      cancel: vi.fn(),
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      status: () => ({
        activeConversationId: 'visible',
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
      }),
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(channel, state, auth, host, {
      workspaceId: 'workspace',
      queueLimit: 5,
      maxMessageChars: 12_000,
      rateLimitPerMinute: 30,
    });
    await controller.start();

    const code = auth.beginPairing('fake');
    const base = {
      channel: 'fake' as const,
      senderId: 'owner-stable-id',
      chatId: 'private-chat',
      chatType: 'private' as const,
      receivedAt: Date.now(),
    };
    await expect(
      channel.emit({ ...base, kind: 'text', providerMessageId: 'pair', text: `/pair ${code}` }),
    ).resolves.toEqual({ kind: 'handled' });

    const prompt: RemoteInboundEvent = {
      ...base,
      kind: 'text',
      providerMessageId: 'prompt-1',
      text: 'implement it',
    };
    const accepted = await channel.emit(prompt);
    expect(accepted.kind).toBe('accepted');
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'c1',
        'implement it',
        undefined,
        expect.objectContaining({ remoteRequestId: expect.any(String) }),
      ),
    );
    await vi.waitFor(() =>
      expect(channel.sent.some((item) => item.text === 'real answer')).toBe(true),
    );
    await vi.waitFor(() =>
      expect(channel.edits.some((item) => item.text === 'Forge: completed.')).toBe(true),
    );
    const duplicate = await channel.emit(prompt);
    expect(duplicate).toMatchObject({ kind: 'duplicate', state: 'completed' });
    await controller.stop();
  });

  it('durably prioritizes /steer before interrupting the active turn', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    await state.enqueue(request({ id: 'ordinary', dedupKey: 'ordinary', admittedAt: 1 }));
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner');
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const channel = new FakeRemoteChannel();
    let busy = true;
    const send = vi.fn(async () => ({ kind: 'completed' as const, finalText: 'done' }));
    const interrupt = vi.fn(async () => {
      busy = false;
    });
    const host = {
      createConversation: vi.fn(),
      restoreConversation: vi.fn(),
      send,
      cancel: vi.fn(),
      interrupt,
      queueIntent: vi.fn(),
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      resolveApproval: vi.fn(),
      status: () => ({
        activeConversationId: 'c1',
        conversations: [],
        requestChains: busy
          ? [{ conversationId: 'c1', userIntentEpoch: 1, stage: 'running', managed: true }]
          : [],
        streamingConversationIds: busy ? ['c1'] : [],
      }),
      contextBudget: () => ({ used: 10, max: 100 }),
      clankerMode: () => false,
      setClankerMode: vi.fn(),
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(channel, state, auth, host, {
      workspaceId: 'workspace',
      queueLimit: 5,
      maxMessageChars: 12_000,
      rateLimitPerMinute: 30,
      modelNames: [],
      attachmentsEnabled: false,
      acceptPdfAttachments: false,
      workspaceAliases: {},
    });
    await controller.start();

    const disposition = await channel.emit({
      channel: 'fake',
      kind: 'text',
      providerMessageId: 'steer-message',
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private',
      receivedAt: 2,
      text: '/steer change direction now',
    });

    expect(disposition).toMatchObject({ kind: 'queued', position: 1 });
    expect(interrupt).toHaveBeenCalledWith('c1');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map((call) => call[1])).toEqual(['change direction now', 'hello']);
    await controller.stop();
  });

  it.each([
    ['cancelled', { kind: 'cancelled' as const }, 'Forge: cancelled.'],
    ['failed', { kind: 'failed' as const, error: 'model failed' }, 'Forge: failed.'],
  ])('ends progress with the real %s outcome', async (_label, outcome, terminalText) => {
    const state = await store();
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner');
    const channel = new FakeRemoteChannel();
    const host = {
      createConversation: vi.fn(async () => ({
        id: 'c1',
        title: 'Remote',
        activeModel: 'local',
        archived: false,
      })),
      send: vi.fn(async () => outcome),
      cancel: vi.fn(async () => undefined),
      queueIntent: vi.fn(),
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      status: () => ({
        activeConversationId: 'visible',
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
      }),
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(
      channel,
      state,
      new RemoteAuth(secrets as unknown as vscode.SecretStorage),
      host,
      {
        workspaceId: 'workspace',
        queueLimit: 5,
        maxMessageChars: 12_000,
        rateLimitPerMinute: 30,
      },
    );
    await controller.start();

    await channel.emit({
      channel: 'fake',
      kind: 'text',
      providerMessageId: `outcome-${_label}`,
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private',
      receivedAt: Date.now(),
      text: 'run it',
    });

    await vi.waitFor(() =>
      expect(channel.edits.some((item) => item.text === terminalText)).toBe(true),
    );
    await controller.stop();
  });

  it('rejects groups and does not invoke Forge', async () => {
    const state = await store();
    const auth = new RemoteAuth(new MemorySecrets() as unknown as vscode.SecretStorage);
    const channel = new FakeRemoteChannel();
    const host = {
      send: vi.fn(),
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(channel, state, auth, host, {
      workspaceId: 'workspace',
      queueLimit: 5,
      maxMessageChars: 100,
      rateLimitPerMinute: 30,
    });
    await controller.start();
    const disposition = await channel.emit({
      channel: 'fake',
      kind: 'text',
      providerMessageId: 'g1',
      senderId: 'someone',
      chatId: 'group',
      chatType: 'group',
      receivedAt: 1,
      text: 'hello',
    });
    expect(disposition.kind).toBe('rejected');
    expect(host.send).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('keeps busy input durable FIFO and suppresses the older chain continuation', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner');
    const channel = new FakeRemoteChannel();
    let busy = true;
    const order: string[] = [];
    const queueIntent = vi.fn();
    const host = {
      send: vi.fn(async (_conversationId: string, text: string) => {
        order.push(text);
        return { kind: 'completed' as const, finalText: `done ${text}` };
      }),
      queueIntent,
      cancel: vi.fn(async () => undefined),
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      status: () => ({
        activeConversationId: 'visible',
        conversations: [],
        requestChains: busy
          ? [{ conversationId: 'c1', userIntentEpoch: 1, stage: 'running', managed: true }]
          : [],
        streamingConversationIds: [],
      }),
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(
      channel,
      state,
      new RemoteAuth(secrets as unknown as vscode.SecretStorage),
      host,
      {
        workspaceId: 'workspace',
        queueLimit: 5,
        maxMessageChars: 100,
        rateLimitPerMinute: 30,
      },
    );
    await controller.start();
    const event = (id: string, text: string): RemoteInboundEvent => ({
      channel: 'fake',
      kind: 'text',
      providerMessageId: id,
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private',
      receivedAt: id === 'one' ? 1 : 2,
      text,
    });
    await expect(channel.emit(event('one', 'first'))).resolves.toMatchObject({
      kind: 'queued',
      position: 1,
    });
    await expect(channel.emit(event('two', 'second'))).resolves.toMatchObject({
      kind: 'queued',
      position: 2,
    });
    expect(queueIntent).toHaveBeenCalledWith('c1');
    busy = false;
    await vi.waitFor(() => expect(order).toEqual(['first', 'second']));
    await controller.stop();
  });

  it('returns retry and never invokes Forge when durable admission fails', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    vi.spyOn(state, 'enqueue').mockRejectedValueOnce(new Error('disk full'));
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner');
    const channel = new FakeRemoteChannel();
    const host = {
      send: vi.fn(),
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      status: () => ({
        activeConversationId: 'visible',
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
      }),
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(
      channel,
      state,
      new RemoteAuth(secrets as unknown as vscode.SecretStorage),
      host,
      {
        workspaceId: 'workspace',
        queueLimit: 5,
        maxMessageChars: 100,
        rateLimitPerMinute: 30,
      },
    );
    await controller.start();
    const disposition = await channel.emit({
      channel: 'fake',
      kind: 'text',
      providerMessageId: 'one',
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private',
      receivedAt: 1,
      text: 'will not run',
    });
    expect(disposition).toMatchObject({ kind: 'retry' });
    expect(host.send).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('routes a Forge-owned approval to the correlated chat and accepts only that action', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner');
    const channel = new FakeRemoteChannel();
    let sink: ToolApprovalSink | undefined;
    let remoteRequestId: string | undefined;
    let finishApproval: ((approved: boolean) => void) | undefined;
    const host = {
      addApprovalSink: (next: ToolApprovalSink) => {
        sink = next;
        return { dispose: () => (sink = undefined) };
      },
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      cancel: vi.fn(async () => undefined),
      status: () => ({
        activeConversationId: 'visible',
        conversations: [],
        requestChains: remoteRequestId
          ? [
              {
                conversationId: 'c1',
                userIntentEpoch: 1,
                stage: 'running' as const,
                managed: true,
                remoteRequestId,
              },
            ]
          : [],
        streamingConversationIds: remoteRequestId ? ['c1'] : [],
      }),
      queueIntent: vi.fn(),
      send: vi.fn(
        async (
          _conversationId: string,
          _text: string,
          _attachments: undefined,
          options: { remoteRequestId?: string },
        ) => {
          remoteRequestId = options.remoteRequestId;
          sink?.requested({
            id: 'approval-1',
            toolName: 'write_file',
            detail: 'src/a.ts',
            dangerous: false,
            conversationId: 'c1',
          });
          const approved = await new Promise<boolean>((resolve) => (finishApproval = resolve));
          return approved
            ? { kind: 'completed' as const, finalText: 'approved work done' }
            : { kind: 'failed' as const, error: 'denied' };
        },
      ),
      resolveApproval: (id: string, approved: boolean) => {
        sink?.resolved({
          id,
          toolName: 'write_file',
          detail: 'src/a.ts',
          dangerous: false,
          conversationId: 'c1',
          approved,
          reason: 'resolved',
        });
        finishApproval?.(approved);
      },
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(
      channel,
      state,
      new RemoteAuth(secrets as unknown as vscode.SecretStorage),
      host,
      {
        workspaceId: 'workspace',
        queueLimit: 5,
        maxMessageChars: 1000,
        rateLimitPerMinute: 30,
      },
    );
    await controller.start();
    await channel.emit({
      channel: 'fake',
      kind: 'text',
      providerMessageId: 'prompt',
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private',
      receivedAt: 1,
      text: 'edit it',
    });
    await vi.waitFor(() =>
      expect(channel.sent.some((item) => item.chatId === 'chat' && item.correlationId)).toBe(true),
    );
    const actionId = channel.sent.find((item) => item.correlationId)?.correlationId;
    expect(actionId).toBeDefined();
    expect(actionId).not.toBe('approval-1');
    await expect(
      channel.emit({
        channel: 'fake',
        kind: 'action',
        providerMessageId: 'action',
        senderId: 'owner',
        chatId: 'chat',
        chatType: 'private',
        receivedAt: 2,
        action: 'approve',
        correlationId: actionId!,
      }),
    ).resolves.toEqual({ kind: 'handled' });
    await vi.waitFor(() =>
      expect(channel.sent.some((item) => item.text === 'approved work done')).toBe(true),
    );
    await expect(
      channel.emit({
        channel: 'fake',
        kind: 'action',
        providerMessageId: 'replay',
        senderId: 'owner',
        chatId: 'chat',
        chatType: 'private',
        receivedAt: 3,
        action: 'deny',
        correlationId: actionId!,
      }),
    ).resolves.toMatchObject({ kind: 'rejected' });
    await controller.stop();
  });
});

describe('remote compaction progress notifications', () => {
  function authFixture(): RemoteAuth {
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner');
    return new RemoteAuth(secrets as unknown as vscode.SecretStorage);
  }

  function controllerFixture(
    channel: FakeRemoteChannel,
    store: RemoteRequestStore,
    host: Partial<ForgeHostFacade>,
  ): RemoteController {
    return new RemoteController(
      channel,
      store,
      authFixture(),
      host as unknown as ForgeHostFacade,
      {
        workspaceId: 'workspace',
        queueLimit: 5,
        maxMessageChars: 4000,
        rateLimitPerMinute: 30,
        modelNames: [],
      },
    );
  }

  it('reverse-looks-up bindings per conversation and filters by transport', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-b',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    await state.setBinding({
      channel: 'telegram',
      chatId: 'tg-1',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });

    const all = state.bindingsForConversation('c1');
    expect(all.map((item) => item.chatId).sort()).toEqual(['chat-a', 'chat-b', 'tg-1']);

    const fakeOnly = state.bindingsForConversation('c1', 'fake');
    expect(fakeOnly.map((item) => item.chatId).sort()).toEqual(['chat-a', 'chat-b']);

    expect(state.bindingsForConversation('missing')).toEqual([]);
  });

  it('notifies the outbox once per bound chat and only for its own transport', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    await state.setBinding({
      channel: 'telegram',
      chatId: 'tg-1',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });

    const channel = new FakeRemoteChannel();
    const controller = controllerFixture(channel, state, {
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
    });
    await controller.start();
    try {
      await controller.enqueueHostNotification('c1', 'Forge: compacting…');
      const pending = state.pendingOutbox('fake');
      expect(pending).toHaveLength(1);
      expect(pending[0].chatId).toBe('chat-a');
      expect(pending[0].text).toBe('Forge: compacting…');
      expect(pending[0].requestId).toMatch(/^host-/);
      // The telegram binding belongs to another transport's controller.
      expect(state.pendingOutbox('telegram')).toHaveLength(0);
    } finally {
      await controller.stop();
    }
  });

  it('is a no-op when the conversation has no binding on this transport', async () => {
    const state = await store();
    const channel = new FakeRemoteChannel();
    const controller = controllerFixture(channel, state, {
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
    });
    await controller.start();
    try {
      await controller.enqueueHostNotification('unbound', 'Forge: compacting…');
      expect(state.pendingOutbox()).toHaveLength(0);
    } finally {
      await controller.stop();
    }
  });

  it('delivers an enqueued host notification through the outbox loop', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const channel = new FakeRemoteChannel();
    const controller = controllerFixture(channel, state, {
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
    });
    await controller.start();
    try {
      await controller.enqueueHostNotification('c1', 'Forge: compacting…');
      // The delivery loop is async; wait for the outbox to drain.
      for (let i = 0; i < 50 && state.pendingOutbox().length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(channel.sent).toContainEqual(
        expect.objectContaining({ chatId: 'chat-a', text: 'Forge: compacting…' }),
      );
      expect(state.outboxHealth().pending).toBe(0);
    } finally {
      await controller.stop();
    }
  });

  it('edits /compact progress from the outcome and still sends the result', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const compact = vi.fn(async () => 'compacted' as const);
    const channel = new FakeRemoteChannel();
    const context = {
      channel,
      store: state,
      host: {
        compact,
        contextBudget: () => ({ used: 1, max: 2 }),
      },
      workspaceId: 'workspace',
      signal: new AbortController().signal,
      inactivityTimeoutMinutes: 30,
      modelNames: [],
      workspaceAliases: {},
    };
    await handleRemoteCommand(
      {
        channel: 'fake',
        kind: 'text',
        providerMessageId: 'compact-1',
        senderId: 'owner',
        chatId: 'chat-a',
        chatType: 'private',
        receivedAt: 1,
        text: '/compact',
      } as RemoteInboundEvent,
      context as never,
      'compact-dedup',
    );
    expect(compact).toHaveBeenCalledWith('c1', {
      trigger: 'remote',
      remoteOrigin: { channel: 'fake', chatId: 'chat-a' },
    });
    expect(channel.progress).toContainEqual({ chatId: 'chat-a', text: 'Forge: compacting…' });
    expect(channel.edits).toContainEqual(
      expect.objectContaining({ chatId: 'chat-a', text: 'Forge: compaction complete.' }),
    );
    expect(channel.sent).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-a',
        text: expect.stringContaining('Forge: compaction compacted'),
      }),
    );
  });

  it('reloads the window on /reload and rejects when reload is unavailable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await runReloadCommandCase();
    } finally {
      vi.useRealTimers();
    }
  });

  async function runReloadCommandCase(): Promise<void> {
    const state = await store();
    const channel = new FakeRemoteChannel();
    const reloadWindow = vi.fn(async () => undefined);
    const context = {
      channel,
      store: state,
      host: {},
      workspaceId: 'workspace',
      signal: new AbortController().signal,
      inactivityTimeoutMinutes: 30,
      modelNames: [],
      workspaceAliases: {},
      reloadWindow,
    };
    await expect(
      handleRemoteCommand(
        {
          channel: 'fake',
          kind: 'text',
          providerMessageId: 'reload-1',
          senderId: 'owner',
          chatId: 'chat-a',
          chatType: 'private',
          receivedAt: 1,
          text: '/reload',
        } as RemoteInboundEvent,
        context as never,
        'reload-1',
      ),
    ).resolves.toEqual({ kind: 'handled' });
    // Deferred on purpose: the reload must not fire until the caller has
    // written the control receipt, or the command is redelivered and reruns.
    expect(reloadWindow).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reloadWindow).toHaveBeenCalledTimes(1);
    expect(channel.sent).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-a',
        text: expect.stringContaining('reloading'),
      }),
    );

    const noReload = { ...context, reloadWindow: undefined };
    await expect(
      handleRemoteCommand(
        {
          channel: 'fake',
          kind: 'text',
          providerMessageId: 'reload-2',
          senderId: 'owner',
          chatId: 'chat-a',
          chatType: 'private',
          receivedAt: 1,
          text: '/reload',
        } as RemoteInboundEvent,
        noReload as never,
        'reload-2',
      ),
    ).resolves.toEqual({ kind: 'rejected', reason: 'remote reload is unavailable' });
    expect(reloadWindow).toHaveBeenCalledTimes(1);
  }

  it('keeps progress as complete when the result send throws after a successful compaction', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const compact = vi.fn(async () => 'compacted' as const);
    const channel = new FakeRemoteChannel();
    // Make the authoritative result send fail — the progress edit must still
    // read "complete", not "failed".
    const origSend = channel.send.bind(channel);
    channel.send = async (chatId: string, text: string) => {
      if (text.includes('Forge: compaction compacted')) throw new Error('send failure');
      await origSend(chatId, text);
    };
    const context = {
      channel,
      store: state,
      host: {
        compact,
        contextBudget: () => ({ used: 1, max: 2 }),
      },
      workspaceId: 'workspace',
      signal: new AbortController().signal,
      inactivityTimeoutMinutes: 30,
      modelNames: [],
      workspaceAliases: {},
    };
    // The result send throws, so the handler rejects — but the progress edit
    // must already be "complete" before the throw propagates.
    await expect(
      handleRemoteCommand(
        {
          channel: 'fake',
          kind: 'text',
          providerMessageId: 'compact-2',
          senderId: 'owner',
          chatId: 'chat-a',
          chatType: 'private',
          receivedAt: 1,
          text: '/compact',
        } as RemoteInboundEvent,
        context as never,
        'compact-dedup-2',
      ),
    ).rejects.toThrow('send failure');
    expect(channel.progress).toContainEqual({ chatId: 'chat-a', text: 'Forge: compacting…' });
    expect(channel.edits).toContainEqual(
      expect.objectContaining({ chatId: 'chat-a', text: 'Forge: compaction complete.' }),
    );
  });

  it('reports a /compact host failure as failed, not complete', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const compact = vi.fn(async () => 'failed' as const);
    const channel = new FakeRemoteChannel();
    const context = {
      channel,
      store: state,
      host: {
        compact,
        contextBudget: () => ({ used: 1, max: 2 }),
      },
      workspaceId: 'workspace',
      signal: new AbortController().signal,
      inactivityTimeoutMinutes: 30,
      modelNames: [],
      workspaceAliases: {},
    };
    await handleRemoteCommand(
      {
        channel: 'fake',
        kind: 'text',
        providerMessageId: 'compact-2',
        senderId: 'owner',
        chatId: 'chat-a',
        chatType: 'private',
        receivedAt: 2,
        text: '/compact',
      } as RemoteInboundEvent,
      context as never,
      'compact-dedup-2',
    );
    expect(channel.edits).toContainEqual(
      expect.objectContaining({ chatId: 'chat-a', text: 'Forge: compaction failed.' }),
    );
    expect(channel.sent).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-a',
        text: expect.stringContaining('Forge: compaction failed'),
      }),
    );
  });

  it('edits /compact progress to failed when host.compact throws', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const compact = vi.fn(async (): Promise<CompactionOutcome> => {
      throw new Error('backend down');
    });
    const channel = new FakeRemoteChannel();
    const context = {
      channel,
      store: state,
      host: {
        compact,
        contextBudget: () => ({ used: 1, max: 2 }),
      },
      workspaceId: 'workspace',
      signal: new AbortController().signal,
      inactivityTimeoutMinutes: 30,
      modelNames: [],
      workspaceAliases: {},
    };
    await expect(
      handleRemoteCommand(
        {
          channel: 'fake',
          kind: 'text',
          providerMessageId: 'compact-3',
          senderId: 'owner',
          chatId: 'chat-a',
          chatType: 'private',
          receivedAt: 3,
          text: '/compact',
        } as RemoteInboundEvent,
        context as never,
        'compact-dedup-3',
      ),
    ).rejects.toThrow('backend down');
    expect(channel.edits).toContainEqual(
      expect.objectContaining({ chatId: 'chat-a', text: 'Forge: compaction failed.' }),
    );
  });

  it('reports context and drops only this remote chat queue', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    await state.enqueue(
      request({ id: 'mine', dedupKey: 'mine', chatId: 'chat-a', providerMessageId: 'mine' }),
    );
    await state.enqueue(
      request({ id: 'other', dedupKey: 'other', chatId: 'chat-b', providerMessageId: 'other' }),
    );
    const channel = new FakeRemoteChannel();
    const context = {
      channel,
      store: state,
      host: { contextBudget: () => ({ used: 75, max: 100 }) },
      workspaceId: 'workspace',
      signal: new AbortController().signal,
      inactivityTimeoutMinutes: 30,
      modelNames: [],
      workspaceAliases: {},
    };
    const command = (text: string, dedupKey: string) =>
      handleRemoteCommand(
        {
          channel: 'fake',
          kind: 'text',
          providerMessageId: dedupKey,
          senderId: 'owner',
          chatId: 'chat-a',
          chatType: 'private',
          receivedAt: 1,
          text,
        } as RemoteInboundEvent,
        context as never,
        dedupKey,
      );

    await command('/context', 'context-command');
    expect(channel.sent.at(-1)?.text).toContain('Remaining: 25 tokens');
    await command('/queue', 'queue-command');
    expect(channel.sent.at(-1)?.text).toContain('hello');
    await command('/drop all', 'drop-command');
    expect(state.getRequest('mine')?.state).toBe('cancelled');
    expect(state.getRequest('other')?.state).toBe('queued');
  });
});
