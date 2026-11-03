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
import { generateTotp } from '../../src/remote/RemoteTotp';
import { totpSecretKey } from '../../src/remote/RemoteSessionAuth';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type {
  UserQuestionRequestEvent,
  UserQuestionSink,
} from '../../src/sidebar/UserQuestionService';

/** Base32 enrollment secret the remote tests already use; 'A' decodes to zero bytes. */
const BASE32_SECRET = 'A'.repeat(32);
const OWNER = 'owner';
const CHAT = 'private-chat';
const CONVERSATION = 'c1';

/** The one line Forge answers with, word for word (owner's wording, 2026-10-27). */
const ALREADY_UNLOCKED =
  'Forge: this chat is already unlocked, so that code was not sent to the model. ' +
  'To send the number to the model, add a word to it.';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

interface Harness {
  channel: FakeRemoteChannel;
  state: RemoteRequestStore;
  controller: RemoteController;
  /** The turn runner: proves a code started no turn when this is never called. */
  send: ReturnType<typeof vi.fn>;
  answerQuestion: ReturnType<typeof vi.fn>;
  /** Raises an ask_user question in this chat, the way the host does. */
  ask: (event: UserQuestionRequestEvent) => void;
  text: (messageId: string, body: string, replyTo?: string) => RemoteInboundEvent;
  sentTexts: () => string[];
  /** A code that is valid right now, for the one event that must authenticate. */
  liveCode: () => string;
  stop: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-unlock-code-'));
  tempDirs.push(directory);
  const state = new RemoteRequestStore(path.join(directory, 'state.json'));
  await state.load();

  const secrets = new MemorySecrets();
  secrets.values.set(`forge.remote.fake.ownerId`, OWNER);
  secrets.values.set(
    totpSecretKey('fake'),
    JSON.stringify({ version: 1, secret: BASE32_SECRET, ownerId: OWNER, enrolledAt: 1 }),
  );
  const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);

  const channel = new FakeRemoteChannel('fake');
  const send = vi.fn(async () => ({ kind: 'completed' as const, finalText: 'real answer' }));
  const answerQuestion = vi.fn(() => true);
  let asked: ((event: UserQuestionRequestEvent) => void) | undefined;
  const host = {
    createConversation: vi.fn(async () => ({
      id: CONVERSATION,
      title: 'Remote',
      activeModel: 'local',
      archived: false,
    })),
    restoreConversation: vi.fn(),
    send,
    cancel: vi.fn(),
    addApprovalSink: () => ({ dispose: () => undefined }),
    addQuestionSink: (sink: UserQuestionSink) => {
      asked = sink.asked;
      return { dispose: () => undefined };
    },
    answerQuestion,
    status: () => ({
      activeConversationId: CONVERSATION,
      conversations: [{ id: CONVERSATION, title: 'Remote', activeModel: 'local' }],
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

  return {
    channel,
    state,
    controller,
    send,
    answerQuestion,
    ask: (event) => {
      if (!asked) throw new Error('the question sink was never registered');
      asked(event);
    },
    text: (messageId, body, replyTo) => ({
      channel: 'fake',
      kind: 'text',
      providerMessageId: messageId,
      senderId: OWNER,
      chatId: CHAT,
      chatType: 'private',
      receivedAt: Date.now(),
      text: body,
      ...(replyTo ? { replyToMessageId: replyTo } : {}),
    }),
    sentTexts: () => channel.sent.map((item) => item.text),
    liveCode: () => generateTotp(BASE32_SECRET, Date.now()).code,
    stop: () => controller.stop(),
  };
}

/** Brings a locked chat to unlocked with one real code, and checks that step. */
async function unlock(f: Harness): Promise<void> {
  const before = f.sentTexts().length;
  await expect(f.channel.emit(f.text('auth-1', f.liveCode()))).resolves.toEqual({
    kind: 'handled',
  });
  expect(f.sentTexts().slice(before)).toContain('Forge: authenticated.');
  expect(f.send).not.toHaveBeenCalled();
}

describe('an unlock code sent to a chat that is already unlocked', () => {
  it('answers with one line and starts no turn', async () => {
    const f = await harness();
    await unlock(f);

    // 095190 is the number the owner actually sent on 2026-10-27: a stale code,
    // so it is not a valid answer to anything, and it became a prompt.
    await expect(f.channel.emit(f.text('stale-1', '095190'))).resolves.toEqual({
      kind: 'handled',
    });
    expect(f.sentTexts()).toContain(ALREADY_UNLOCKED);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.state.queued(CONVERSATION)).toHaveLength(0);
    await f.stop();
  });

  it('treats /auth <code> the same way', async () => {
    const f = await harness();
    await unlock(f);

    await expect(f.channel.emit(f.text('stale-2', '/auth 095190'))).resolves.toEqual({
      kind: 'handled',
    });
    expect(f.sentTexts()).toContain(ALREADY_UNLOCKED);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.state.queued(CONVERSATION)).toHaveLength(0);
    await f.stop();
  });

  it('lets the number answer a question that is waiting in that chat', async () => {
    const f = await harness();
    await unlock(f);
    await f.state.setBinding({
      channel: 'fake',
      chatId: CHAT,
      workspaceId: 'workspace',
      conversationId: CONVERSATION,
    });
    f.ask({
      id: 'q-port',
      prompt: 'Which port should the share use?',
      specs: [{ prompt: 'Which port should the share use?', multiSelect: false, options: [] }],
      conversationId: CONVERSATION,
    });

    await expect(f.channel.emit(f.text('answer-1', '095190'))).resolves.toEqual({
      kind: 'handled',
    });
    await vi.waitFor(() => expect(f.answerQuestion).toHaveBeenCalledWith('q-port', '095190'));
    expect(f.sentTexts()).not.toContain(ALREADY_UNLOCKED);
    expect(f.send).not.toHaveBeenCalled();
    await f.stop();
  });

  it('still unlocks a locked chat with the code, as today', async () => {
    const f = await harness();
    const code = f.liveCode();

    await expect(f.channel.emit(f.text('auth-only', code))).resolves.toEqual({
      kind: 'handled',
    });
    expect(f.sentTexts()).toContain('Forge: authenticated.');
    expect(f.sentTexts()).not.toContain(ALREADY_UNLOCKED);
    // The same number sent again right after: the chat is unlocked by then, so
    // the guard holds it out of the model. It is not a TOTP replay check doing
    // the work — an authenticated session is never asked to prove itself again.
    await expect(f.channel.emit(f.text('replay-1', code))).resolves.toEqual({ kind: 'handled' });
    expect(f.sentTexts()).toContain(ALREADY_UNLOCKED);
    expect(f.send).not.toHaveBeenCalled();
    await f.stop();
  });

  it('sends a number inside a sentence to the model', async () => {
    const f = await harness();
    await unlock(f);

    await f.channel.emit(f.text('order-1', 'Order 123456'));
    await vi.waitFor(() =>
      expect(f.send).toHaveBeenCalledWith(
        CONVERSATION,
        'Order 123456',
        undefined,
        expect.objectContaining({ remoteRequestId: expect.any(String) }),
      ),
    );
    expect(f.sentTexts()).not.toContain(ALREADY_UNLOCKED);
    await f.stop();
  });
});
