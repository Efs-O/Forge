import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemotePendingPrompt } from '../../src/remote/RemotePendingPrompt';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { generateTotp } from '../../src/remote/RemoteTotp';
import type { RemoteInboundEvent } from '../../src/remote/types';
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
    text: 'refactor the parser',
    ...overrides,
  } as RemoteInboundEvent;
}

function textEvent(overrides: Partial<RemoteInboundEvent> = {}) {
  return event(overrides) as Extract<RemoteInboundEvent, { kind: 'text' }>;
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
    addQuestionSink: () => ({ dispose: () => undefined }),
    answerQuestion: () => false,
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

/** An enrolled owner whose session has already expired, so the next text challenges. */
async function enrolledRig(inactivityTimeoutMinutes?: number) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-held-prompt-'));
  tempDirs.push(directory);
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  await store.setBinding({
    channel: 'fake',
    chatId: 'chat-raw-id',
    workspaceId: 'workspace',
    conversationId: 'c1',
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
  const controller = new RemoteController(channel, store, auth, forgeHost, {
    workspaceId: 'workspace',
    queueLimit: 5,
    maxMessageChars: 12_000,
    rateLimitPerMinute: 60,
    ...(inactivityTimeoutMinutes === undefined ? {} : { inactivityTimeoutMinutes }),
  });
  await controller.start();
  return { controller, channel, forgeHost, code, secret };
}

describe('held remote prompt', () => {
  it('holds a prompt through the challenge and runs it after the code', async () => {
    const { controller, channel, forgeHost, code } = await enrolledRig();

    await expect(
      channel.emit(event({ providerMessageId: 'p1', text: 'refactor the parser' })),
    ).resolves.toEqual({ kind: 'handled' });
    expect(forgeHost.send).not.toHaveBeenCalled();
    expect(
      channel.sent.some((item) => item.text.includes('Your prompt is held')),
    ).toBe(true);

    // Authenticating now returns the replayed prompt's own disposition, not a
    // bare `handled` -- the held prompt was admitted as part of the same turn.
    await expect(
      channel.emit(event({ providerMessageId: 'auth', text: code })),
    ).resolves.toMatchObject({ kind: 'accepted', requestId: expect.any(String) });
    await vi.waitFor(() =>
      expect(forgeHost.send).toHaveBeenCalledWith(
        'c1',
        'refactor the parser',
        undefined,
        expect.objectContaining({ remoteRequestId: expect.any(String) }),
      ),
    );
    // The replay is echoed, never silent.
    expect(
      channel.sent.some((item) => item.text.includes('running your held prompt')),
    ).toBe(true);
    expect((forgeHost.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    await controller.stop();
  });

  it('names the inactivity timeout when the session expired', async () => {
    const { controller, channel } = await enrolledRig(45);
    await channel.emit(event({ providerMessageId: 'p1', text: 'do the thing' }));
    // Never authenticated in this process, so the cause is a plain lock, not a timeout.
    expect(channel.sent.some((item) => item.text.includes('authentication required'))).toBe(true);
    expect(channel.sent.some((item) => item.text.includes('45 min idle'))).toBe(false);
    await controller.stop();
  });

  it('drops the held prompt after repeated wrong codes lock the session out', async () => {
    const { controller, channel, forgeHost, code } = await enrolledRig();
    await channel.emit(event({ providerMessageId: 'p1', text: 'dangerous work' }));

    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt++) {
      await channel.emit(event({ providerMessageId: `bad-${attempt}`, text: wrong }));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forgeHost.send).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('drops the held prompt when the owner is unpaired', async () => {
    const { controller, channel, forgeHost, code } = await enrolledRig();
    await channel.emit(event({ providerMessageId: 'p1', text: 'dangerous work' }));

    // Unpairing clears session state; the held prompt must go with it, or the
    // next owner to pair inherits the last one's queued work.
    controller.forgetChannel('fake');
    await channel.emit(event({ providerMessageId: 'auth', text: code }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forgeHost.send).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('does not hold a command, and never replays one after the code', async () => {
    const { controller, channel, forgeHost, code } = await enrolledRig();

    await expect(
      channel.emit(event({ providerMessageId: 'p1', text: '/reload' })),
    ).resolves.toEqual({ kind: 'handled' });
    expect(channel.sent.some((item) => item.text.includes('Your prompt is held'))).toBe(false);
    expect(channel.sent.some((item) => item.text.includes('commands are not held'))).toBe(true);

    // The code authenticates and nothing else: /reload must not fire from a
    // keystroke the user made before they were even logged in.
    await expect(
      channel.emit(event({ providerMessageId: 'auth', text: code })),
    ).resolves.toEqual({ kind: 'handled' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forgeHost.send).not.toHaveBeenCalled();
    expect(channel.sent.some((item) => item.text.includes('running your held prompt'))).toBe(false);
    expect(channel.sent.some((item) => item.text.includes('reloading'))).toBe(false);
    await controller.stop();
  });

  it('still holds /steer, which carries a prompt', async () => {
    const { controller, channel, forgeHost, code } = await enrolledRig();

    await channel.emit(event({ providerMessageId: 'p1', text: '/steer rewrite the loop' }));
    expect(channel.sent.some((item) => item.text.includes('Your prompt is held'))).toBe(true);
    await channel.emit(event({ providerMessageId: 'auth', text: code }));
    await vi.waitFor(() =>
      expect(forgeHost.send).toHaveBeenCalledWith(
        'c1',
        'rewrite the loop',
        undefined,
        expect.objectContaining({ remoteRequestId: expect.any(String) }),
      ),
    );
    await controller.stop();
  });

  it('does not hold a prompt from a sender who is not the owner', async () => {
    const { controller, channel, forgeHost } = await enrolledRig();
    await channel.emit(
      event({ providerMessageId: 'p1', senderId: 'intruder', text: 'exfiltrate' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(forgeHost.send).not.toHaveBeenCalled();
    expect(channel.sent.some((item) => item.text.includes('Your prompt is held'))).toBe(false);
    await controller.stop();
  });
});

describe('RemotePendingPrompt', () => {
  it('keeps one slot per chat, newest wins', () => {
    const pending = new RemotePendingPrompt();
    pending.hold(textEvent({ text: 'first' }));
    pending.hold(textEvent({ text: 'second' }));
    expect(pending.take('fake', 'chat-raw-id')?.text).toBe('second');
    expect(pending.take('fake', 'chat-raw-id')).toBeUndefined();
  });

  it('separates chats', () => {
    const pending = new RemotePendingPrompt();
    pending.hold(textEvent({ chatId: 'a', text: 'for a' }));
    pending.hold(textEvent({ chatId: 'b', text: 'for b' }));
    expect(pending.take('fake', 'a')?.text).toBe('for a');
    expect(pending.take('fake', 'b')?.text).toBe('for b');
  });

  it('refuses to replay a prompt held past its TTL', () => {
    const pending = new RemotePendingPrompt(1_000);
    pending.hold(textEvent({ text: 'stale' }), 10_000);
    expect(pending.take('fake', 'chat-raw-id', 11_500)).toBeUndefined();
  });

  it('replays a prompt still inside its TTL', () => {
    const pending = new RemotePendingPrompt(1_000);
    pending.hold(textEvent({ text: 'fresh' }), 10_000);
    expect(pending.take('fake', 'chat-raw-id', 10_500)?.text).toBe('fresh');
  });

  it('clears one chat and a whole channel', () => {
    const pending = new RemotePendingPrompt();
    pending.hold(textEvent({ chatId: 'a', text: 'for a' }));
    pending.hold(textEvent({ chatId: 'b', text: 'for b' }));
    pending.clear('fake', 'a');
    expect(pending.take('fake', 'a')).toBeUndefined();
    expect(pending.take('fake', 'b')?.text).toBe('for b');

    pending.hold(textEvent({ chatId: 'c', text: 'for c' }));
    pending.clearChannel('fake');
    expect(pending.take('fake', 'c')).toBeUndefined();
  });
});
