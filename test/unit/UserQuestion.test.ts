import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { openQuickInputs } from '../support/vscode';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { makeAskUserTool } from '../../src/tools/uxTools';
import { RemoteQuestionBridge } from '../../src/remote/RemoteQuestionBridge';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

beforeEach(() => {
  openQuickInputs.length = 0;
});

/** The box the service just raised. */
function currentInput() {
  const input = openQuickInputs.at(-1);
  if (!input) throw new Error('no quick input was raised');
  return input;
}

describe('UserQuestionService', () => {
  it('answers from the local box and keeps it open against focus loss', async () => {
    const service = new UserQuestionService();
    const pending = service.ask({ prompt: 'Which file?' });
    const box = currentInput();
    expect(box.ignoreFocusOut).toBe(true);
    expect(box.visible).toBe(true);

    box.accept('src/index.ts');
    await expect(pending).resolves.toBe('src/index.ts');
    expect(box.disposed).toBe(true);
  });

  it('treats a dismissed box as no answer', async () => {
    const service = new UserQuestionService();
    const pending = service.ask({ prompt: 'Which file?' });
    currentInput().hide();
    await expect(pending).resolves.toBeUndefined();
  });

  it('lets a remote answer win the race and closes the stale local box', async () => {
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({ prompt: 'Which file?', conversationId: 'c1' });

    const id = asked.mock.calls[0]?.[0].id as string;
    expect(service.hasPending('c1')).toBe(true);
    expect(service.answer(id, 'from telegram')).toBe(true);

    await expect(pending).resolves.toBe('from telegram');
    // The desktop prompt must not linger over a question already answered.
    expect(currentInput().disposed).toBe(true);
    expect(service.hasPending('c1')).toBe(false);
  });

  it('resolves once when answered twice', async () => {
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({ prompt: 'Which file?', conversationId: 'c1' });
    const id = asked.mock.calls[0]?.[0].id as string;

    expect(service.answer(id, 'first')).toBe(true);
    expect(service.answer(id, 'second')).toBe(false);
    await expect(pending).resolves.toBe('first');
  });

  it('maps a bare number onto the offered options', async () => {
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({
      prompt: 'Which backend?',
      options: ['llama.cpp', 'ollama'],
      conversationId: 'c1',
    });
    const id = asked.mock.calls[0]?.[0].id as string;
    service.answer(id, '2');
    await expect(pending).resolves.toBe('ollama');
  });

  it('passes text through when it is not an index into the options', async () => {
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({
      prompt: 'Which backend?',
      options: ['llama.cpp', 'ollama'],
      conversationId: 'c1',
    });
    const id = asked.mock.calls[0]?.[0].id as string;
    service.answer(id, 'neither, use vllm');
    await expect(pending).resolves.toBe('neither, use vllm');
  });

  it('cancels a pending question when the turn aborts', async () => {
    const service = new UserQuestionService();
    const controller = new AbortController();
    const pending = service.ask({ prompt: 'Which file?', signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(currentInput().disposed).toBe(true);
  });

  it('does not raise a box for an already-aborted turn', async () => {
    const service = new UserQuestionService();
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.ask({ prompt: 'Which file?', signal: controller.signal }),
    ).resolves.toBeUndefined();
    expect(openQuickInputs).toHaveLength(0);
  });
});

function bridgeRig(options: { canDeliver?: boolean; remoteRequestId?: string | undefined } = {}) {
  const channel = new FakeRemoteChannel();
  const service = new UserQuestionService();
  const store = {
    getRequest: (id: string) =>
      id === 'req-1' ? { id: 'req-1', channel: 'fake', chatId: 'chat-1' } : undefined,
  } as unknown as RemoteRequestStore;
  const auth = {
    canDeliver: async () => options.canDeliver ?? true,
  } as unknown as RemoteAuth;
  const host = {
    addQuestionSink: (sink: Parameters<ForgeHostFacade['addQuestionSink']>[0]) =>
      service.addSink(sink),
    answerQuestion: (id: string, text: string) => service.answer(id, text),
    status: () => ({
      activeConversationId: 'c1',
      conversations: [],
      requestChains: [
        {
          conversationId: 'c1',
          ...('remoteRequestId' in options
            ? { remoteRequestId: options.remoteRequestId }
            : { remoteRequestId: 'req-1' }),
        },
      ],
      streamingConversationIds: [],
    }),
  } as unknown as ForgeHostFacade;
  const bridge = new RemoteQuestionBridge(
    channel,
    store,
    auth,
    host,
    new AbortController().signal,
    4_000,
  );
  bridge.start();
  return { bridge, channel, service };
}

describe('RemoteQuestionBridge', () => {
  it('sends the question to the chat that started the turn and answers from its reply', async () => {
    const { bridge, channel, service } = bridgeRig();
    const pending = service.ask({ prompt: 'Which file?', conversationId: 'c1' });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.text).toContain('Forge asks: Which file?');
    expect(bridge.hasPending('chat-1')).toBe(true);

    expect(bridge.answerText('chat-1', 'src/index.ts')).toBe(true);
    await expect(pending).resolves.toBe('src/index.ts');
  });

  it('numbers the options it offers', async () => {
    const { channel, service } = bridgeRig();
    void service.ask({
      prompt: 'Which backend?',
      options: ['llama.cpp', 'ollama'],
      conversationId: 'c1',
    });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.text).toContain('1. llama.cpp');
    expect(channel.sent[0]?.text).toContain('2. ollama');
  });

  it('stays silent for a local turn with no remote chain', async () => {
    const { bridge, channel, service } = bridgeRig({ remoteRequestId: undefined });
    void service.ask({ prompt: 'Which file?', conversationId: 'c1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(channel.sent).toHaveLength(0);
    expect(bridge.hasPending('chat-1')).toBe(false);
  });

  it('never hands the question to an expired session', async () => {
    const { channel, service } = bridgeRig({ canDeliver: false });
    void service.ask({ prompt: 'TOP SECRET question', conversationId: 'c1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(channel.sent).toHaveLength(0);
  });

  it('reports no pending question for an unknown chat', () => {
    const { bridge } = bridgeRig();
    expect(bridge.answerText('someone-else', 'hello')).toBe(false);
  });
});

/**
 * A live controller whose host answers questions through a real service, so the
 * routing decision in handle() is exercised rather than mocked around.
 */
async function controllerRig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-question-'));
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  await store.setBinding({
    channel: 'fake',
    chatId: 'chat-1',
    workspaceId: 'workspace',
    conversationId: 'c1',
  });
  await store.enqueue({
    id: 'req-1',
    dedupKey: 'req-1',
    channel: 'fake',
    chatId: 'chat-1',
    providerMessageId: 'req-1',
    conversationId: 'c1',
    text: 'original prompt',
    receivedAt: 1,
    state: 'running',
    updatedAt: 1,
  });
  const secrets = {
    values: new Map<string, string>([['forge.remote.fake.ownerId', 'owner-1']]),
    get(key: string) {
      return Promise.resolve(this.values.get(key));
    },
    store(key: string, value: string) {
      this.values.set(key, value);
      return Promise.resolve();
    },
    delete(key: string) {
      this.values.delete(key);
      return Promise.resolve();
    },
    onDidChange: () => ({ dispose: () => undefined }),
  };
  // No TOTP enrollment, so every owner message is authorized outright and the
  // test isolates question routing from the auth gate.
  const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
  const service = new UserQuestionService();
  const channel = new FakeRemoteChannel();
  const send = vi.fn(async () => ({ kind: 'completed' as const, finalText: 'done' }));
  const host = {
    createConversation: vi.fn(async () => ({
      id: 'c1',
      title: 'Remote',
      activeModel: 'local',
      archived: false,
    })),
    restoreConversation: vi.fn(),
    send,
    cancel: vi.fn(async () => undefined),
    queueIntent: vi.fn(),
    resolveApproval: vi.fn(),
    addApprovalSink: () => ({ dispose: () => undefined }),
    addQuestionSink: (sink: Parameters<ForgeHostFacade['addQuestionSink']>[0]) =>
      service.addSink(sink),
    answerQuestion: (id: string, text: string) => service.answer(id, text),
    status: () => ({
      activeConversationId: 'c1',
      conversations: [],
      requestChains: [{ conversationId: 'c1', remoteRequestId: 'req-1' }],
      streamingConversationIds: [],
    }),
    clankerMode: vi.fn(() => false),
    setClankerMode: vi.fn(),
    contextBudget: vi.fn(() => ({ used: 1, max: 2 })),
    compact: vi.fn(async () => 'compacted' as const),
  } as unknown as ForgeHostFacade;
  const controller = new RemoteController(channel, store, auth, host, {
    workspaceId: 'workspace',
    queueLimit: 5,
    maxMessageChars: 4_000,
    rateLimitPerMinute: 60,
  });
  await controller.start();
  const cleanup = async () => {
    await controller.stop();
    await fs.rm(directory, { recursive: true, force: true });
  };
  return { controller, channel, service, send, cleanup };
}

function chatEvent(text: string, providerMessageId: string) {
  return {
    channel: 'fake' as const,
    kind: 'text' as const,
    providerMessageId,
    senderId: 'owner-1',
    chatId: 'chat-1',
    chatType: 'private' as const,
    receivedAt: Date.now(),
    text,
  };
}

describe('RemoteController question routing', () => {
  it('routes the next reply into the question instead of queueing a new prompt', async () => {
    const { channel, service, send, cleanup } = await controllerRig();
    const pending = service.ask({ prompt: 'Which file?', conversationId: 'c1' });
    await vi.waitFor(() => expect(channel.sent.some((i) => i.text.includes('Forge asks'))).toBe(true));

    await expect(channel.emit(chatEvent('src/index.ts', 'answer'))).resolves.toEqual({
      kind: 'handled',
    });
    await expect(pending).resolves.toBe('src/index.ts');
    // The reply answered the agent; it must not also become queued work.
    expect(send).not.toHaveBeenCalled();
    await cleanup();
  });

  it('still runs commands while a question waits, so the chat is never stranded', async () => {
    const { channel, service, cleanup } = await controllerRig();
    const pending = service.ask({ prompt: 'Which file?', conversationId: 'c1' });
    await vi.waitFor(() => expect(channel.sent.some((i) => i.text.includes('Forge asks'))).toBe(true));

    await channel.emit(chatEvent('/status', 'status'));
    // The command ran as a command: the question is still outstanding.
    expect(service.hasPending('c1')).toBe(true);

    await channel.emit(chatEvent('src/index.ts', 'answer'));
    await expect(pending).resolves.toBe('src/index.ts');
    await cleanup();
  });
});

describe('ask_user tool', () => {
  it('cancels the question when the turn is aborted', async () => {
    const service = new UserQuestionService();
    const tool = makeAskUserTool(service);
    const controller = new AbortController();
    const call = tool.handler(
      { prompt: 'Which file?' },
      { beforeMutate: () => undefined, abortSignal: controller.signal },
    );
    expect(currentInput().visible).toBe(true);

    // Without the signal threaded through, this box stays open forever: it no
    // longer self-dismisses on blur, and a remote asker has no Esc key.
    controller.abort();
    await expect(call).resolves.toContain('did not answer');
    expect(currentInput().disposed).toBe(true);
  });

  it('routes the answer back through the service, whatever surface gave it', async () => {
    const service = new UserQuestionService();
    const tool = makeAskUserTool(service);
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const call = tool.handler(
      { prompt: 'Which file?' },
      { beforeMutate: () => undefined, conversationId: 'c1' },
    );

    const id = asked.mock.calls[0]?.[0].id as string;
    expect(service.answer(id, 'src/index.ts')).toBe(true);
    await expect(call).resolves.toBe('src/index.ts');
  });
});
