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
import { generateTotp } from '../../src/remote/RemoteTotp';
import { RemoteTransportLease } from '../../src/remote/RemoteTransportLease';
import type { RemoteChannel, RemoteInboundEvent, RemoteRequestRecord } from '../../src/remote/types';
import type { CompactionEvent } from '../../src/sidebar/CompactionService';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { CONVERSATION_BUSY_ERROR } from '../../src/sidebar/SendPipeline';

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
    clankerMode: vi.fn(() => false),
    setClankerMode: vi.fn(),
    contextBudget: vi.fn(() => ({ used: 1000, max: 4000 })),
    compact: vi.fn(async () => 'compacted' as const),
    ...overrides,
  } as ForgeHostFacade;
}

describe('remote authorization and privacy hardening', () => {
  it('blocks all owner routing while TOTP is locked, then drains only after authentication', async () => {
    const { store } = await newStore();
    await store.setBinding({
      channel: 'fake',
      chatId: 'chat-raw-id',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    await store.enqueue({
      id: 'queued-totp',
      dedupKey: 'queued-totp',
      channel: 'fake',
      chatId: 'chat-raw-id',
      providerMessageId: 'queued-totp',
      conversationId: 'c1',
      text: 'queued prompt',
      receivedAt: 1,
      state: 'queued',
      updatedAt: 1,
    });
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner-raw-id');
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const secret = await auth.createTotpEnrollmentSecret('fake');
    const now = Date.now();
    const code = generateTotp(secret, now).code;
    await auth.confirmTotpEnrollment('fake', secret, code, now);
    const channel = new FakeRemoteChannel();
    const forgeHost = host();
    const controller = new RemoteController(
      channel,
      store,
      auth,
      forgeHost,
      { workspaceId: 'workspace', queueLimit: 5, maxMessageChars: 100, rateLimitPerMinute: 30 },
    );
    await controller.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forgeHost.send).not.toHaveBeenCalled();
    await expect(channel.emit(event({ providerMessageId: 'status', text: '/status' }))).resolves.toEqual({
      kind: 'handled',
    });
    await expect(channel.emit(event({ providerMessageId: 'auth', text: code }))).resolves.toEqual({
      kind: 'handled',
    });
    await vi.waitFor(() => expect(forgeHost.send).toHaveBeenCalledWith('c1', 'queued prompt', undefined, {
      remoteRequestId: 'queued-totp',
    }));
    await controller.stop();
  });

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
    const secrets = new MemorySecrets();
    const audit = new RemoteAuditLog(filePath, secrets as unknown as vscode.SecretStorage);
    await audit.record(event(), 'request_accepted', 'request-1');
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).not.toContain('owner-raw-id');
    expect(raw).not.toContain('chat-raw-id');
    expect(raw).not.toContain('TOP SECRET PROMPT');
    expect(secrets.values.size).toBe(1);
    expect(JSON.parse(raw).entries[0]).toMatchObject({
      channel: 'fake',
      action: 'request_accepted',
      requestId: 'request-1',
    });
  });
});

describe('remote owner commands', () => {
  async function ownerController(overrides = {}) {
    const { store } = await newStore();
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner-raw-id');
    const channel = new FakeRemoteChannel();
    const forgeHost = host(overrides);
    const controller = new RemoteController(
      channel,
      store,
      new RemoteAuth(secrets as unknown as vscode.SecretStorage),
      forgeHost,
      { workspaceId: 'workspace', queueLimit: 5, maxMessageChars: 500, rateLimitPerMinute: 30 },
    );
    await controller.start();
    return { channel, controller, forgeHost };
  }

  it('reports the context meter and the approval gate in /status', async () => {
    const { channel, controller } = await ownerController({ clankerMode: vi.fn(() => true) });
    await channel.emit(event({ providerMessageId: 'new', text: '/new' }));
    await channel.emit(event({ providerMessageId: 'status', text: '/status' }));
    const reply = channel.sent.at(-1)?.text ?? '';
    expect(reply).toContain('1000/4000 tokens (25%)');
    // A remote owner cannot see the sidebar, so a disabled gate must be stated.
    expect(reply).toContain('CLANKER');
    await controller.stop();
  });

  it('confirms a pressed approval button, clears its keyboard, and rejects a replay', async () => {
    let sink: { requested: (e: never) => void; resolved: (e: never) => void } | undefined;
    // The chain is what ties an approval back to the remote request that caused
    // it; filled in once the prompt below has been admitted.
    let chainRequestId: string | undefined;
    const { channel, controller, forgeHost } = await ownerController({
      addApprovalSink: (registered: never) => {
        sink = registered as unknown as typeof sink;
        return { dispose: () => undefined };
      },
      status: () => ({
        activeConversationId: 'c1',
        conversations: [],
        requestChains: [
          {
            conversationId: 'c1',
            userIntentEpoch: 1,
            stage: 'running',
            managed: true,
            ...(chainRequestId ? { remoteRequestId: chainRequestId } : {}),
          },
        ],
        streamingConversationIds: [],
      }),
    });
    await channel.emit(event({ providerMessageId: 'new', text: '/new' }));
    const accepted = await channel.emit(event({ providerMessageId: 'ask', text: 'edit README' }));
    const requestId = 'requestId' in accepted ? accepted.requestId : undefined;
    expect(requestId).toBeDefined();
    chainRequestId = requestId;

    const approval = {
      id: 'approval-1',
      conversationId: 'c1',
      toolName: 'edit_file',
      detail: '{}',
      dangerous: false,
    };
    sink?.requested(approval as never);
    await vi.waitFor(() => expect(channel.sent.at(-1)?.correlationId).toBe('approval-1'));
    const prompt = channel.sent.at(-1);
    expect(prompt?.correlationId).toBe('approval-1');

    const action = event({
      providerMessageId: 'press',
      kind: 'action',
      action: 'approve',
      correlationId: 'approval-1',
    });
    await expect(channel.emit(action)).resolves.toEqual({ kind: 'handled' });
    expect(forgeHost.resolveApproval).toHaveBeenCalledWith('approval-1', true);
    // A second press of a button Telegram never takes away must not re-resolve.
    await expect(
      channel.emit({ ...action, providerMessageId: 'press-again' }),
    ).resolves.toMatchObject({ kind: 'rejected' });
    expect(forgeHost.resolveApproval).toHaveBeenCalledTimes(1);

    sink?.resolved({ ...approval, approved: true, reason: 'remote' } as never);
    await vi.waitFor(() =>
      expect(channel.retracted).toEqual([{ chatId: 'chat-raw-id', correlationId: 'approval-1' }]),
    );
    const confirmation = channel.sent.at(-1);
    expect(confirmation?.text).toContain('approved');
    // A correlationId here would hang a second live keyboard on the notice.
    expect(confirmation?.correlationId).toBeUndefined();
    await controller.stop();
  });

  it('toggles clanker mode only for the owner and only with a valid argument', async () => {
    const { channel, controller, forgeHost } = await ownerController();
    await expect(
      channel.emit(event({ providerMessageId: 'bad', text: '/clanker maybe' })),
    ).resolves.toMatchObject({ kind: 'rejected' });
    expect(forgeHost.setClankerMode).not.toHaveBeenCalled();
    await expect(
      channel.emit(event({ providerMessageId: 'on', text: '/clanker on' })),
    ).resolves.toEqual({ kind: 'handled' });
    expect(forgeHost.setClankerMode).toHaveBeenCalledWith(true);
    await controller.stop();
  });

  it('compacts the bound conversation and reports the new budget', async () => {
    const { channel, controller, forgeHost } = await ownerController();
    // Unbound chats have nothing to compact.
    await expect(
      channel.emit(event({ providerMessageId: 'early', text: '/compact' })),
    ).resolves.toMatchObject({ kind: 'rejected' });
    await channel.emit(event({ providerMessageId: 'new', text: '/new' }));
    await expect(
      channel.emit(event({ providerMessageId: 'compact', text: '/compact' })),
    ).resolves.toEqual({ kind: 'handled' });
    expect(forgeHost.compact).toHaveBeenCalledWith('c1', expect.objectContaining({ trigger: 'remote' }));
    expect(channel.sent.at(-1)?.text).toContain('compaction compacted');
    await controller.stop();
  });
});

describe('remote durable boundaries', () => {
  it('durably suppresses replayed control-command side effects', async () => {
    const { store } = await newStore();
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner-raw-id');
    const channel = new FakeRemoteChannel();
    const forgeHost = host();
    const controller = new RemoteController(
      channel,
      store,
      new RemoteAuth(secrets as unknown as vscode.SecretStorage),
      forgeHost,
      { workspaceId: 'workspace', queueLimit: 5, maxMessageChars: 100, rateLimitPerMinute: 30 },
    );
    await controller.start();
    const command = event({ providerMessageId: 'command', text: '/new' });
    await expect(channel.emit(command)).resolves.toEqual({ kind: 'handled' });
    await expect(channel.emit(command)).resolves.toEqual({ kind: 'handled' });
    expect(forgeHost.createConversation).toHaveBeenCalledTimes(1);
    await controller.stop();
  });

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
      receivedAt: 100,
      admittedAt: 1,
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

  it('atomically claims only one request across competing transport drains', async () => {
    const { store } = await newStore();
    const first: RemoteRequestRecord = {
      id: 'first',
      dedupKey: 'first',
      channel: 'telegram',
      chatId: 'telegram-chat',
      providerMessageId: 'first',
      conversationId: 'shared',
      text: 'first',
      receivedAt: 100,
      admittedAt: 1,
      state: 'queued',
      updatedAt: Date.now(),
    };
    await store.enqueue(first);
    await store.enqueue({
      ...first,
      id: 'second',
      dedupKey: 'second',
      channel: 'whatsapp',
      chatId: 'whatsapp-chat',
      providerMessageId: 'second',
      text: 'second',
      receivedAt: 1,
      admittedAt: 2,
    });
    const claims = await Promise.all([
      store.claimNext('shared', 'telegram'),
      store.claimNext('shared', 'whatsapp'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.id).toBe('first');
    expect(store.queued('shared').map((item) => item.id)).toEqual(['second']);
  });

  it('requeues durable work that loses a last-millisecond local admission race', async () => {
    const { store } = await newStore();
    await store.setBinding({
      channel: 'fake',
      chatId: 'chat-raw-id',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.fake.ownerId', 'owner-raw-id');
    const channel = new FakeRemoteChannel();
    const send = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'failed', error: CONVERSATION_BUSY_ERROR })
      .mockResolvedValueOnce({ kind: 'completed', finalText: 'done' });
    const controller = new RemoteController(
      channel,
      store,
      new RemoteAuth(secrets as unknown as vscode.SecretStorage),
      host({ send }),
      { workspaceId: 'workspace', queueLimit: 5, maxMessageChars: 100, rateLimitPerMinute: 30 },
    );
    await controller.start();
    const accepted = await channel.emit(event());
    expect(accepted.kind).toBe('accepted');
    const requestId = accepted.kind === 'accepted' ? accepted.requestId : '';
    await vi.waitFor(() => expect(store.getRequest(requestId)?.state).toBe('completed'), {
      timeout: 1_000,
    });
    expect(send).toHaveBeenCalledTimes(2);
    await controller.stop();
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

  it('leaves a locked outbox item pending without retrying until explicitly kicked', async () => {
    const { store } = await newStore();
    await store.enqueue({
      id: 'locked-request',
      dedupKey: 'locked-request',
      channel: 'fake',
      chatId: 'chat',
      providerMessageId: 'message',
      conversationId: 'c1',
      text: 'prompt',
      receivedAt: 1,
      state: 'queued',
      updatedAt: 1,
    });
    await store.finish('locked-request', 'completed', { notification: 'answer' });
    const channel = new FakeRemoteChannel();
    let unlocked = false;
    const delivery = new RemoteOutboxDelivery(
      channel,
      store,
      100,
      new AbortController().signal,
      1,
      undefined,
      () => unlocked,
    );
    delivery.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channel.sent).toHaveLength(0);
    expect(store.pendingOutbox()[0]).toMatchObject({ attempts: 0, state: 'pending' });
    unlocked = true;
    delivery.kick();
    await vi.waitFor(() => expect(channel.sent.at(-1)?.text).toBe('answer'));
    await delivery.stop();
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

  it('rewrites the lease in place instead of zero-filling it on heartbeat', async () => {
    const { directory } = await newStore();
    const lost = vi.fn();
    const lease = await RemoteTransportLease.acquire({
      directory,
      key: 'telegram',
      workspaceId: 'w1',
      instanceId: 'one',
      heartbeatMs: 10,
      onLost: lost,
    });
    const leasePath = path.join(directory, 'telegram.lease.json');
    const first = JSON.parse(await fs.readFile(leasePath, 'utf8'));
    // Several heartbeats must each land at offset 0. Appending past a truncated
    // length would zero-fill the gap and every later parse would fail.
    await vi.waitFor(
      async () =>
        expect(
          JSON.parse(await fs.readFile(leasePath, 'utf8')).heartbeatAt,
        ).toBeGreaterThan(first.heartbeatAt),
      { timeout: 500 },
    );
    const raw = await fs.readFile(leasePath);
    expect(raw.includes(0)).toBe(false);
    expect(JSON.parse(raw.toString('utf8')).token).toBe(first.token);
    expect(await lease.verify()).toBe(true);
    expect(lost).not.toHaveBeenCalled();
    await lease.release();
  });

  it('reclaims a corrupt lease file instead of wedging acquisition', async () => {
    const { directory } = await newStore();
    await fs.mkdir(directory, { recursive: true });
    const leasePath = path.join(directory, 'telegram.lease.json');
    await fs.writeFile(leasePath, Buffer.alloc(283));
    const lease = await RemoteTransportLease.acquire({
      directory,
      key: 'telegram',
      workspaceId: 'w1',
      instanceId: 'one',
      heartbeatMs: 10_000,
      onLost: vi.fn(),
    });
    expect(await lease.verify()).toBe(true);
    await lease.release();
  });
});

describe('remote runtime lifecycle', () => {
  it('subscribes to compaction before channel startup', async () => {
    const { directory } = await newStore();
    const persisted = new RemoteRequestStore(path.join(directory, 'remote-state-v2.json'));
    await persisted.load();
    await persisted.setBinding({
      channel: 'telegram',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
    let compactionListener: ((event: CompactionEvent) => void) | undefined;
    const sent: Array<{ chatId: string; text: string }> = [];
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.telegram.ownerId', 'owner');
    const channel: RemoteChannel = {
      name: 'telegram',
      onEvent: () => ({ dispose: () => undefined }),
      async start() {
        compactionListener?.({ conversationId: 'c1', phase: 'started', trigger: 'auto' });
      },
      async send(chatId, text) {
        sent.push({ chatId, text });
      },
      async retractPrompt() {
        // Not used by this lifecycle test.
      },
    };
    const runtime = new RemoteRuntime({
      storageDirectory: directory,
      workspaceId: 'workspace',
      host: host({
        onCompactionEvent: (listener) => {
          compactionListener = listener;
          return { dispose: () => (compactionListener = undefined) };
        },
      }),
      secrets: secrets as unknown as vscode.SecretStorage,
      channelFactories: { telegram: () => channel },
      notifyLocal: vi.fn(),
    });
    const enabled = ForgeConfigSchema.parse({
      models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
      remote: { enabled: true, telegram: { enabled: true } },
    });

    await runtime.applyConfig(enabled);
    await vi.waitFor(() =>
      expect(sent).toContainEqual({ chatId: 'chat-a', text: 'Forge: compacting…' }),
    );
    await runtime.dispose();
  });

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
    await expect(runtime.validationStatus(enabled)).resolves.toMatchObject({
      enabled: true,
      transports: [
        {
          name: 'telegram',
          configured: true,
          active: true,
          leaseOwned: true,
          ownerPaired: false,
          providerOk: true,
        },
        { name: 'whatsapp', configured: false, active: false, leaseOwned: false },
      ],
    });
    await runtime.applyConfig(enabled);
    expect(channels).toHaveLength(1);
    await expect(channels[0]!.emit(event())).resolves.toMatchObject({ kind: 'rejected' });
    await runtime.dispose();
    expect(runtime.activeTransports()).toEqual([]);
    await expect(channels[0]!.emit(event())).resolves.toMatchObject({ kind: 'retry' });
  });
});
