import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RichDraftTransport } from '../../src/remote/telegramRichDraft';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type {
  UserQuestionAnsweredEvent,
  UserQuestionRequestEvent,
} from '../../src/sidebar/UserQuestionService';

/**
 * Phase 2: Telegram's native Stop button, end to end through the controller.
 *
 * A `generation_stopped` event arrives with a chat id and a draft id and no
 * sender, so three things must all hold before anything is cancelled: the
 * ordinary owner gate must pass on the derived identity, the chat+draft pair
 * must match a live draft, and a redelivered Stop must not cancel a second
 * time — nor a later turn.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-draft-test-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
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

const base = {
  channel: 'telegram' as const,
  senderId: 'owner-1',
  chatId: 'chat-1',
  chatType: 'private' as const,
  receivedAt: 1,
};

interface Fixture {
  channel: FakeRemoteChannel;
  controller: RemoteController;
  host: ForgeHostFacade;
  sent: ForgeHostFacade['send'];
  cancel: ForgeHostFacade['cancel'];
  finalizes: Array<{ chatId: string; text: string }>;
  release: () => void;
  /** Resolves when the drain has written this turn's final status. */
  drainDone: Promise<void>;
  /** Raises an ask_user gate for the live turn, as the host question service would. */
  askQuestion: (event: UserQuestionRequestEvent) => void;
  answerQuestion: ReturnType<typeof vi.fn>;
  /** Messages the controller reported through its onError option. */
  errors: string[];
}

/**
 * One fixture, one live draft: a paired owner sends a prompt, the drain opens a
 * rich draft for it, and `host.send` blocks so the turn is still live while the
 * Stop updates arrive.
 */
async function liveTurnDraft(): Promise<Fixture> {
  const state = await store();
  const secrets = new MemorySecrets();
  const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
  const channel = new FakeRemoteChannel('telegram');

  const finalizes: Array<{ chatId: string; text: string }> = [];
  const richDraft: RichDraftTransport = {
    beginDraft: async () => ({ kind: 'open', draftId: 42 }),
    updateDraft: async () => undefined,
    finalizeStatus: async (chatId, text) => {
      finalizes.push({ chatId, text });
      drainDone();
      return 'final-1';
    },
  };
  channel.richDraft = richDraft;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const errors: string[] = [];
  let drainDone!: () => void;
  const drainFinished = new Promise<void>((resolve) => (drainDone = resolve));
  const cancel = vi.fn();
  const answerQuestion = vi.fn(() => true);
  let ask!: (event: UserQuestionRequestEvent) => void;
  const host = {
    createConversation: vi.fn(async () => ({
      id: 'c1',
      title: 'Remote',
      activeModel: 'local',
      archived: false,
    })),
    restoreConversation: vi.fn(),
    send: vi.fn(async () => {
      await gate;
      return { kind: 'cancelled' as const, finalText: '' };
    }),
    cancel,
    addApprovalSink: () => ({ dispose: () => undefined }),
    addQuestionSink: (sink: {
      asked(event: UserQuestionRequestEvent): void;
      answered(event: UserQuestionAnsweredEvent): void;
    }) => {
      ask = (event) => sink.asked(event);
      return { dispose: () => undefined };
    },
    answerQuestion,
    status: () => ({
      activeConversationId: 'c1',
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
    onError: (message) => errors.push(message),
  });
  await controller.start();

  const code = auth.beginPairing('telegram');
  await channel.emit({ ...base, kind: 'text', providerMessageId: 'pair', text: `/pair ${code}` });
  await channel.emit({ ...base, kind: 'text', providerMessageId: 'go', text: 'hello' });
  // The drain registers the draft before it starts the turn, so once send has
  // been called the draft is live and the turn is blocked on the gate.
  await vi.waitFor(() => expect(host.send).toHaveBeenCalled());

  return {
    channel,
    controller,
    host,
    sent: host.send,
    cancel,
    finalizes,
    release,
    drainDone: drainFinished,
    askQuestion: (event) => ask(event),
    answerQuestion,
    errors,
  };
}

function stopped(draftId: number, providerMessageId: string, overrides = {}): unknown {
  return {
    ...base,
    ...overrides,
    kind: 'generation_stopped',
    draftId,
    providerMessageId,
  };
}

describe('remote generation_stopped (Phase 2 native Stop)', () => {
  it('cancels the conversation that owns the matching live draft', async () => {
    const f = await liveTurnDraft();

    await expect(f.channel.emit(stopped(42, 'stop-1'))).resolves.toEqual({ kind: 'handled' });
    expect(f.cancel).toHaveBeenCalledWith('c1');

    f.release();
    await f.drainDone;
    await f.controller.stop();
  });

  it('ignores a stale or foreign draft id without cancelling anything', async () => {
    const f = await liveTurnDraft();

    // Never opened here: an id from another transport, or from a turn that has
    // already ended. Cancelling on a mismatch would stop a turn the user never
    // pressed Stop on.
    await expect(f.channel.emit(stopped(999, 'stop-999'))).resolves.toEqual({ kind: 'handled' });
    await expect(f.channel.emit(stopped(41, 'stop-41'))).resolves.toEqual({ kind: 'handled' });
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone;
    await f.controller.stop();
  });

  it('ignores a matching draft id in a different chat', async () => {
    const f = await liveTurnDraft();

    // Same owner, same draft id, different chat: the registry key is the pair,
    // so half a match must not cancel. (senderId stays the owner, or this would
    // be an auth rejection rather than a matching test.)
    await expect(f.channel.emit(stopped(42, 'stop-other', { chatId: 'chat-2' }))).resolves.toEqual(
      { kind: 'handled' },
    );
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone;
    await f.controller.stop();
  });

  it('cancels once per draft, so a redelivered Stop cannot cancel twice', async () => {
    const f = await liveTurnDraft();

    await expect(f.channel.emit(stopped(42, 'stop-a'))).resolves.toEqual({ kind: 'handled' });
    // A different provider id, so this is not caught by message-id deduplication:
    // it is the registry entry dropped after the first Stop that answers it.
    await expect(f.channel.emit(stopped(42, 'stop-b'))).resolves.toEqual({ kind: 'handled' });
    expect(f.cancel).toHaveBeenCalledTimes(1);

    f.release();
    await f.drainDone;
    await f.controller.stop();
  });

  it('deduplicates an identical Stop update by its Telegram update id', async () => {
    const f = await liveTurnDraft();

    await expect(f.channel.emit(stopped(42, 'stop-dup'))).resolves.toEqual({ kind: 'handled' });
    const again = await f.channel.emit(stopped(42, 'stop-dup'));
    expect(again.kind === 'rejected' || again.kind === 'handled').toBe(true);
    expect(f.cancel).toHaveBeenCalledTimes(1);

    f.release();
    await f.drainDone;
    await f.controller.stop();
  });

  it('holds a Stop update behind the auth gate', async () => {
    const state = await store();
    const secrets = new MemorySecrets();
    secrets.values.set('forge.remote.telegram.ownerId', 'someone-else');
    const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
    const channel = new FakeRemoteChannel('telegram');
    const cancel = vi.fn();
    const host = {
      createConversation: vi.fn(async () => ({
        id: 'c1',
        title: 'Remote',
        activeModel: 'local',
        archived: false,
      })),
      restoreConversation: vi.fn(),
      send: vi.fn(async () => ({ kind: 'completed' as const, finalText: 'x' })),
      cancel,
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      status: () => ({
        activeConversationId: 'c1',
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

    // The derived senderId is only a claim; pairing requires a /pair *text*
    // event, so a Stop update cannot establish authority for a chat that has
    // none, and cannot borrow another chat's.
    await expect(
      channel.emit(stopped(42, 'stop-stranger', { senderId: 'stranger' })),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'sender is not paired' });
    await expect(channel.emit(stopped(42, 'stop-owner'))).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'sender is not paired',
    });
    expect(cancel).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('refuses a Stop update in a group chat', async () => {
    const f = await liveTurnDraft();

    await expect(
      f.channel.emit(stopped(42, 'stop-group', { chatType: 'group' })),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'private chats only' });
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone;
    await f.controller.stop();
  });

  it('rejects a non-positive draft id as an invalid event', async () => {
    const f = await liveTurnDraft();

    await expect(f.channel.emit(stopped(0, 'stop-zero'))).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'invalid remote event',
    });
    expect(f.cancel).not.toHaveBeenCalled();

    f.release();
    await f.drainDone;
    await f.controller.stop();
  });

  it('cancels an active turn while a question gate is pending, without consuming the Stop', async () => {
    const f = await liveTurnDraft();

    // The live turn is now blocked on ask_user, so the question bridge owns this
    // chat's next plain text. A Stop is a native button update, not text: the
    // question flow must not claim it, or the turn would sit running with the
    // user believing they had stopped it.
    f.askQuestion({
      id: 'q1',
      prompt: 'Which build?',
      options: ['debug', 'release'],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(f.channel.inlineKeyboards).toHaveLength(1));

    await expect(f.channel.emit(stopped(42, 'stop-while-question'))).resolves.toEqual({
      kind: 'handled',
    });
    expect(f.answerQuestion).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledWith('c1');

    // The gate is still live afterwards: the Stop cancelled the turn, it did not
    // answer the question, and the chat's next plain text is still the answer.
    await expect(
      f.channel.emit({ ...base, kind: 'text', providerMessageId: 'answer-1', text: 'debug' }),
    ).resolves.toEqual({ kind: 'handled' });
    expect(f.answerQuestion).toHaveBeenCalledWith('q1', 'debug');

    f.release();
    await f.drainDone;
    await f.controller.stop();
  });

  it('reports a Stop whose cancel failed, and still acknowledges the update', async () => {
    const f = await liveTurnDraft();
    // A host whose cancel throws: the turn is still running, and silence would
    // hide that. The controller reads `host.cancel` at call time, so replacing
    // it here is what the real host failing mid-turn looks like.
    f.host.cancel = vi.fn(async () => {
      throw new Error('host busy');
    });

    // Acknowledged, not retried: a Stop the user meant must not loop.
    await expect(f.channel.emit(stopped(42, 'stop-fail'))).resolves.toEqual({
      kind: 'handled',
    });
    // Reported through the controller's onError, with the underlying cause.
    await vi.waitFor(() => expect(f.errors).toHaveLength(1));
    expect(f.errors[0]).toContain('could not cancel the turn');
    expect(f.errors[0]).toContain('host busy');

    f.release();
    await f.drainDone;
    await f.controller.stop();
  });

  it('finalizes a persistent status on cancellation, separate from the answer', async () => {
    const f = await liveTurnDraft();

    await f.channel.emit(stopped(42, 'stop-1'));
    f.release();
    await f.drainDone;

    // The preview expires on Telegram's side, so this send is what leaves the
    // turn's outcome visible — and it is status only, never the answer.
    expect(f.finalizes).toEqual([{ chatId: 'chat-1', text: 'Forge: cancelled.' }]);
    // The answer/notification travels its own path, not the status message.
    expect(f.channel.sent.map((m) => m.text)).not.toContain('Forge: cancelled.');
    await f.controller.stop();
  });
});
