import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore, remoteDedupKey } from '../../src/remote/RemoteRequestStore';
import { RemoteLeaseError, RemoteTransportLease } from '../../src/remote/RemoteTransportLease';
import type { RemoteInboundEvent, RemoteRequestRecord } from '../../src/remote/types';
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

    const reloaded = new RemoteRequestStore(
      path.join(tempDirs[tempDirs.length - 1]!, 'state.json'),
    );
    await reloaded.load();
    expect(reloaded.pendingOutbox()).toHaveLength(1);

    const running = request({ id: 'r2', dedupKey: 'r2', state: 'running' });
    await reloaded.enqueue(running);
    const secondReload = new RemoteRequestStore(
      path.join(tempDirs[tempDirs.length - 1]!, 'state.json'),
    );
    await secondReload.load();
    expect(secondReload.getRequest('r2')?.state).toBe('unknown');
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
    const duplicate = await channel.emit(prompt);
    expect(duplicate).toMatchObject({ kind: 'duplicate', state: 'completed' });
    await controller.stop();
  });

  it('rejects groups and does not invoke Forge', async () => {
    const state = await store();
    const auth = new RemoteAuth(new MemorySecrets() as unknown as vscode.SecretStorage);
    const channel = new FakeRemoteChannel();
    const host = {
      send: vi.fn(),
      addApprovalSink: () => ({ dispose: () => undefined }),
    } as unknown as ForgeHostFacade;
    const controller = new RemoteController(channel, state, auth, host, {
      workspaceId: 'workspace',
      queueLimit: 5,
      maxMessageChars: 100,
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
      addApprovalSink: () => ({ dispose: () => undefined }),
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
      { workspaceId: 'workspace', queueLimit: 5, maxMessageChars: 100 },
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
      { workspaceId: 'workspace', queueLimit: 5, maxMessageChars: 100 },
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
      { workspaceId: 'workspace', queueLimit: 5, maxMessageChars: 1000 },
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
      expect(channel.sent).toContainEqual(
        expect.objectContaining({ chatId: 'chat', correlationId: 'approval-1' }),
      ),
    );
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
        correlationId: 'approval-1',
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
        correlationId: 'approval-1',
      }),
    ).resolves.toMatchObject({ kind: 'rejected' });
    await controller.stop();
  });
});
