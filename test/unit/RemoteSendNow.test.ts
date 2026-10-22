import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteRequestStore, remoteDedupKey } from '../../src/remote/RemoteRequestStore';
import { handleRemoteSendNow } from '../../src/remote/remoteSendNow';
import { handleRemoteSessionCommand } from '../../src/remote/RemoteSessionCommands';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import type {
  RemoteChannel,
  RemoteInboundEvent,
  RemoteRequestRecord,
} from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { RemoteAuth } from '../../src/remote/RemoteAuth';

const tempDirs: string[] = [];
const requestId = '11111111-1111-4111-8111-111111111111';

afterEach(async () => {
  for (const directory of tempDirs.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-send-now-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

function request(id: string, receivedAt: number): RemoteRequestRecord {
  return {
    id,
    dedupKey: remoteDedupKey('telegram', 'chat', id),
    channel: 'telegram',
    chatId: 'chat',
    providerMessageId: id,
    conversationId: 'conversation',
    text: id,
    receivedAt,
    admittedAt: receivedAt,
    state: 'queued',
    updatedAt: receivedAt,
  };
}

function event(overrides: Partial<Extract<RemoteInboundEvent, { kind: 'send_now_action' }>> = {}) {
  return {
    channel: 'telegram',
    kind: 'send_now_action',
    providerMessageId: 'callback',
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 2,
    requestId,
    messageId: '90',
    ...overrides,
  } as const;
}

function harness(state: RemoteRequestStore, busy: boolean) {
  const channel = {
    name: 'telegram',
    answerCallbackQuery: vi.fn(async () => undefined),
    retireTappedQueuedReceipt: vi.fn(async () => undefined),
  } as unknown as RemoteChannel;
  const host = {
    queueIntent: vi.fn(),
    interrupt: vi.fn(async () => undefined),
  } as unknown as ForgeHostFacade;
  const auth = { touch: vi.fn() } as unknown as RemoteAuth;
  const kickDrain = vi.fn();
  const onError = vi.fn();
  const audit = { record: vi.fn(async () => undefined) };
  const deps = {
    channel,
    store: state,
    auth,
    host,
    audit: audit as unknown as import('../../src/remote/RemoteAuditLog').RemoteAuditLog,
    isBusy: () => busy,
    kickDrain,
    onError,
  };
  return { channel, host, auth, kickDrain, onError, audit, deps };
}

describe('Send now action', () => {
  it('promotes the queued request, interrupts a busy turn, and drains it first', async () => {
    const state = await store();
    await state.enqueue(request('earlier', 1));
    await state.enqueue(request(requestId, 2));
    const fixture = harness(state, true);
    await handleRemoteSendNow(event(), fixture.deps);

    expect(state.getRequest(requestId)).toMatchObject({ state: 'queued', priority: 'steer' });
    expect(fixture.host.queueIntent).toHaveBeenCalledOnce();
    expect(fixture.host.interrupt).toHaveBeenCalledOnce();
    expect(fixture.kickDrain).toHaveBeenCalledWith('conversation');
    expect(fixture.channel.retireTappedQueuedReceipt).toHaveBeenCalledWith(requestId, 'chat', '90');
    expect(fixture.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send_now_action' }),
      'send_now',
      requestId,
    );
    expect(fixture.auth.touch).toHaveBeenCalledOnce();
    expect(await state.claimNext('conversation', 'telegram')).toMatchObject({ id: requestId });
  });

  it('runs the promoted item when idle without interrupting', async () => {
    const state = await store();
    await state.enqueue(request(requestId, 1));
    const fixture = harness(state, false);
    await handleRemoteSendNow(event(), fixture.deps);
    expect(fixture.host.interrupt).not.toHaveBeenCalled();
    expect(fixture.kickDrain).toHaveBeenCalledOnce();
  });

  it('rejects a wrong chat and a claim race without interrupting', async () => {
    const state = await store();
    await state.enqueue(request(requestId, 1));
    const fixture = harness(state, true);
    const result = await handleRemoteSendNow(event({ chatId: 'foreign' }), fixture.deps);
    expect(result).toMatchObject({
      kind: 'rejected',
      reason: 'Too late — Forge already picked this up.',
    });
    expect(state.getRequest(requestId)).toMatchObject({ state: 'queued' });
    expect(fixture.host.interrupt).not.toHaveBeenCalled();

    vi.spyOn(state, 'contactMutate').mockImplementationOnce(async () => false as never);
    const raced = await handleRemoteSendNow(event(), fixture.deps);
    expect(raced).toMatchObject({
      kind: 'rejected',
      reason: 'Too late — Forge already picked this up.',
    });
    expect(fixture.host.interrupt).not.toHaveBeenCalled();
  });

  it('rejects a stale callback and retires the tapped message after restart', async () => {
    const state = await store();
    const fixture = harness(state, true);
    const result = await handleRemoteSendNow(event(), fixture.deps);
    expect(result).toMatchObject({
      kind: 'rejected',
      reason: 'Too late — Forge already picked this up.',
    });
    expect(fixture.channel.retireTappedQueuedReceipt).toHaveBeenCalledWith(requestId, 'chat', '90');
    expect(fixture.channel.answerCallbackQuery).toHaveBeenCalledWith(
      'callback',
      'Too late — Forge already picked this up.',
    );
    expect(fixture.host.interrupt).not.toHaveBeenCalled();
  });

  it('keeps the promoted prompt queued when interrupt fails and reports the failure', async () => {
    const state = await store();
    await state.enqueue(request(requestId, 1));
    const fixture = harness(state, true);
    vi.mocked(fixture.host.interrupt).mockRejectedValueOnce(new Error('busy lock'));
    await handleRemoteSendNow(event(), fixture.deps);
    expect(fixture.onError).toHaveBeenCalledWith(expect.stringContaining('busy lock'));
    expect(state.getRequest(requestId)).toMatchObject({ state: 'queued', priority: 'steer' });
    expect(fixture.kickDrain).toHaveBeenCalledOnce();
  });
});

describe('owner /start command', () => {
  it('returns the same help response as /help', async () => {
    const sendHelp = vi.fn(async () => undefined);
    const context = {
      channel: { parseMode: 'HTML', sendHelp },
      signal: new AbortController().signal,
    } as unknown as RemoteCommandContext;
    const ownerEvent = {
      channel: 'telegram' as const,
      kind: 'text' as const,
      providerMessageId: 'start',
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private' as const,
      receivedAt: 1,
      text: '/start',
    };
    await expect(
      handleRemoteSessionCommand('/start', undefined, ownerEvent, context),
    ).resolves.toEqual({
      kind: 'handled',
    });
    expect(sendHelp).toHaveBeenCalledWith('chat', expect.any(String), expect.objectContaining({
      signal: expect.any(AbortSignal),
      parseMode: 'HTML',
      buttons: expect.any(Array),
    }));
  });

  it('retires a receipt when /drop cancels its queued request', async () => {
    const state = await store();
    await state.setBinding({
      channel: 'telegram',
      chatId: 'chat',
      workspaceId: 'workspace',
      conversationId: 'conversation',
    });
    await state.enqueue(request(requestId, 1));
    const retire = vi.fn(async () => undefined);
    const context = {
      channel: { send: vi.fn(async () => undefined), retireQueuedReceipt: retire },
      store: state,
      host: {} as ForgeHostFacade,
      workspaceId: 'workspace',
      signal: new AbortController().signal,
      inactivityTimeoutMinutes: 30,
      rateLimitPerMinute: 30,
      modelEntries: [],
      workspaceAliases: {},
    } as unknown as RemoteCommandContext;
    const dropEvent = {
      channel: 'telegram' as const,
      kind: 'text' as const,
      providerMessageId: 'drop',
      senderId: 'owner',
      chatId: 'chat',
      chatType: 'private' as const,
      receivedAt: 2,
      text: '/drop all',
    };
    await expect(handleRemoteSessionCommand('/drop', 'all', dropEvent, context)).resolves.toEqual({
      kind: 'handled',
    });
    expect(state.getRequest(requestId)?.state).toBe('cancelled');
    expect(retire).toHaveBeenCalledWith(requestId);
  });
});
