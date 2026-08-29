import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ForgeConfigSchema } from '../../src/config/schema';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuditLog } from '../../src/remote/RemoteAuditLog';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteOutboxDelivery } from '../../src/remote/RemoteOutboxDelivery';
import { RemoteRateLimiter } from '../../src/remote/RemoteRateLimiter';
import { RemoteRequestStore, remoteDedupKey } from '../../src/remote/RemoteRequestStore';
import { RemoteRuntime } from '../../src/remote/RemoteRuntime';
import { RemoteTransportLease } from '../../src/remote/RemoteTransportLease';
import type { RemoteInboundEvent, RemoteRequestRecord } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
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

function event(overrides: Partial<RemoteInboundEvent> = {}): RemoteInboundEvent {
  return {
    channel: 'fake',
    kind: 'text',
    providerMessageId: 'm1',
    senderId: 'owner-raw-id',
    chatId: 'chat-raw-id',
    chatType: 'private',
    receivedAt: Date.now(),
    text: 'TOP SECRET PROMPT',
    ...overrides,
  } as RemoteInboundEvent;
}

async function newStore(): Promise<{ store: RemoteRequestStore; directory: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-hardening-'));
  tempDirs.push(directory);
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  return { store, directory };
}

function host(overrides: Partial<ForgeHostFacade> = {}): ForgeHostFacade {
  return {
    createConversation: vi.fn(async () => ({
      id: 'c1',
      title: 'Remote',
      activeModel: 'local',
      archived: false,
    })),
    restoreConversation: vi.fn(),
    send: vi.fn(async () => ({ kind: 'completed' as const, finalText: 'done' })),
    cancel: vi.fn(async () => undefined),
    queueIntent: vi.fn(),
    resolveApproval: vi.fn(),
    addApprovalSink: () => ({ dispose: () => undefined }),
    status: () => ({
      activeConversationId: 'visible',
      conversations: [],
      requestChains: [],
      streamingConversationIds: [],
    }),
    ...overrides,
  } as ForgeHostFacade;
}

describe('remote authorization and privacy hardening', () => {
  it('enforces pairing grammar, expiry, one-time use, and stable exact owner identity', async () => {
    const secrets = new MemorySecrets();
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const code = auth.beginPairing('fake', 1_000);
    await expect(auth.tryPair(event({ text: `/pair  ${code}` }), 1_001)).resolves.toBe('rejected');
    await expect(auth.tryPair(event({ text: `/pair ${code}` }), 301_001)).resolves.toBe('rejected');

    const fresh = auth.beginPairing('fake', 10_000);
    await expect(auth.tryPair(event({ text: `/pair ${fresh}` }), 10_001)).resolves.toBe('paired');
    await expect(auth.tryPair(event({ text: `/pair ${fresh}` }), 10_002)).resolves.toBe('rejected');
    await expect(auth.isOwner(event())).resolves.toBe(true);
    await expect(auth.isOwner(event({ senderId: 'OWNER-RAW-ID' }))).resolves.toBe(false);

    const exhausted = auth.beginPairing('fake', 20_000);
    const wrong = exhausted === '00000000' ? '11111111' : '00000000';
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(auth.tryPair(event({ text: `/pair ${wrong}` }), 20_001 + attempt)).resolves.toBe(
        'rejected',
      );
    }
    await expect(auth.tryPair(event({ text: `/pair ${exhausted}` }), 20_010)).resolves.toBe(
      'rejected',
    );
  });

  it('rate-limits each exact owner/chat tuple with a bounded window', () => {
    const limiter = new RemoteRateLimiter(2, 1_000);
    expect(limiter.allow('owner', 1_000)).toBe(true);
    expect(limiter.allow('owner', 1_001)).toBe(true);
    expect(limiter.allow('owner', 1_002)).toBe(false);
    expect(limiter.allow('other', 1_002)).toBe(true);
    expect(limiter.allow('owner', 2_001)).toBe(true);
  });

  it('writes only bounded hashed audit metadata', async () => {
    const { directory } = await newStore();
    const filePath = path.join(directory, 'audit.json');
    const audit = new RemoteAuditLog(filePath);
    await audit.record(event(), 'request_accepted', 'request-1');
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).not.toContain('owner-raw-id');
    expect(raw).not.toContain('chat-raw-id');
    expect(raw).not.toContain('TOP SECRET PROMPT');
    expect(JSON.parse(raw).entries[0]).toMatchObject({
      channel: 'fake',
      action: 'request_accepted',
      requestId: 'request-1',
    });
  });
});

describe('remote durable boundaries', () => {
  it('rejects stale cross-workspace bindings and queue overflow before host execution', async () => {
    const { store } = await newStore();
    await store.setBinding({
      channel: 'fake',
      chatId: 'chat-raw-id',
      workspaceId: 'other-workspace',
      conversationId: 'c1',
    });
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner-raw-id');
    const channel = new FakeRemoteChannel();
    const forgeHost = host();
    const controller = new RemoteController(
      channel,
      store,
      new RemoteAuth(secrets as unknown as vscode.SecretStorage),
      forgeHost,
      { workspaceId: 'workspace', queueLimit: 1, maxMessageChars: 100, rateLimitPerMinute: 30 },
    );
    await controller.start();
    await expect(channel.emit(event())).resolves.toMatchObject({ kind: 'rejected' });
    expect(forgeHost.send).not.toHaveBeenCalled();
    await controller.stop();

    await store.setBinding({
      channel: 'fake',
      chatId: 'chat-raw-id',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const queued: RemoteRequestRecord = {
      id: 'queued',
      dedupKey: remoteDedupKey('fake', 'chat-raw-id', 'old'),
      channel: 'fake',
      chatId: 'chat-raw-id',
      providerMessageId: 'old',
      conversationId: 'c1',
      text: 'old',
      receivedAt: 1,
      state: 'queued',
      updatedAt: Date.now(),
    };
    await store.enqueue(queued);
    const busyHost = host({
      status: () => ({
        activeConversationId: 'visible',
        conversations: [],
        requestChains: [
          { conversationId: 'c1', userIntentEpoch: 1, stage: 'running', managed: true },
        ],
        streamingConversationIds: [],
      }),
    });
    const overflow = new RemoteController(
      channel,
      store,
      new RemoteAuth(secrets as unknown as vscode.SecretStorage),
      busyHost,
      { workspaceId: 'workspace', queueLimit: 1, maxMessageChars: 100, rateLimitPerMinute: 30 },
    );
    await overflow.start();
    await expect(channel.emit(event({ providerMessageId: 'new' }))).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'remote queue is full',
    });
    await overflow.stop();
  });

  it('prunes expired terminal requests but retains active work', async () => {
    const { store } = await newStore();
    await store.enqueue({
      id: 'old-terminal',
      dedupKey: 'old-terminal',
      channel: 'fake',
      chatId: 'chat',
      providerMessageId: 'old-terminal',
      conversationId: 'c1',
      text: 'old',
      receivedAt: 1,
      state: 'completed',
      updatedAt: 1,
    });
    await store.enqueue({
      id: 'old-queued',
      dedupKey: 'old-queued',
      channel: 'fake',
      chatId: 'chat',
      providerMessageId: 'old-queued',
      conversationId: 'c1',
      text: 'old',
      receivedAt: 1,
      state: 'queued',
      updatedAt: 1,
    });
    expect(store.getRequest('old-terminal')).toBeUndefined();
    expect(store.getRequest('old-queued')).toBeDefined();
  });

  it('abandons a notification after bounded channel-scoped delivery attempts', async () => {
    const { store } = await newStore();
    await store.enqueue({
      id: 'request',
      dedupKey: 'request',
      channel: 'fake',
      chatId: 'chat',
      providerMessageId: 'message',
      conversationId: 'c1',
      text: 'prompt',
      receivedAt: 1,
      state: 'queued',
      updatedAt: Date.now(),
    });
    await store.finish('request', 'completed', { notification: 'answer' });
    const channel = new FakeRemoteChannel();
    vi.spyOn(channel, 'send').mockRejectedValue(new Error('offline'));
    const delivery = new RemoteOutboxDelivery(channel, store, 100, new AbortController().signal, 0);
    delivery.start();
    await vi.waitFor(() => expect(store.outboxHealth().abandoned).toBe(1));
    await delivery.stop();
    expect(channel.send).toHaveBeenCalledTimes(10);
  });

  it('detects fencing loss and never removes the replacement lease', async () => {
    const { directory } = await newStore();
    const lost = vi.fn();
    const lease = await RemoteTransportLease.acquire({
      directory,
      key: 'telegram-account',
      workspaceId: 'w1',
      instanceId: 'one',
      heartbeatMs: 20,
      onLost: lost,
    });
    const leasePath = path.join(directory, 'telegram-account.lease.json');
    const replacement = JSON.parse(await fs.readFile(leasePath, 'utf8'));
    replacement.token = randomUUID();
    replacement.instanceId = 'two';
    await fs.writeFile(leasePath, JSON.stringify(replacement), 'utf8');
    await vi.waitFor(() => expect(lost).toHaveBeenCalled(), { timeout: 500 });
    await lease.release();
    expect(JSON.parse(await fs.readFile(leasePath, 'utf8')).token).toBe(replacement.token);
  });
});

describe('remote runtime lifecycle', () => {
  it('replaces channel subscriptions on config reload and fully disposes', async () => {
    const { directory } = await newStore();
    const channels: FakeRemoteChannel[] = [];
    const runtime = new RemoteRuntime({
      storageDirectory: directory,
      workspaceId: 'workspace',
      host: host(),
      secrets: new MemorySecrets() as unknown as vscode.SecretStorage,
      channelFactories: {
        telegram: () => {
          const channel = new FakeRemoteChannel();
          channels.push(channel);
          return channel;
        },
      },
      notifyLocal: vi.fn(),
    });
    const enabled = ForgeConfigSchema.parse({
      models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      remote: { enabled: true, telegram: { enabled: true } },
    });
    await runtime.applyConfig(enabled);
    expect(runtime.activeTransports()).toEqual(['telegram']);
    await runtime.applyConfig(enabled);
    expect(channels).toHaveLength(2);
    await expect(channels[0]!.emit(event())).resolves.toMatchObject({ kind: 'retry' });
    await runtime.dispose();
    expect(runtime.activeTransports()).toEqual([]);
    await expect(channels[1]!.emit(event())).resolves.toMatchObject({ kind: 'retry' });
  });
});
