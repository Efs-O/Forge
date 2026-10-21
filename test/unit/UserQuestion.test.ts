import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { openQuickInputs } from '../support/vscode';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { makeAskUserTool } from '../../src/tools/askUserTool';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
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
  it('does not raise the VS Code box when a sink presents the question locally', async () => {
    const service = new UserQuestionService();
    const asked: string[] = [];
    service.addSink({
      asked: (event) => asked.push(event.id),
      answered: () => undefined,
      presentsLocally: () => true,
    });

    const pending = service.ask({ prompt: 'Which file?', options: ['a', 'b'] });
    // The whole point: a multiple-choice question used to open the command
    // palette's quick pick over the editor while the sidebar showed nothing.
    expect(openQuickInputs).toHaveLength(0);
    expect(asked).toHaveLength(1);

    service.answer(asked[0]!, '2');
    await expect(pending).resolves.toBe('b');
  });

  it('still raises the box when no sink presents locally', async () => {
    const service = new UserQuestionService();
    service.addSink({
      asked: () => undefined,
      answered: () => undefined,
      presentsLocally: () => false,
    });

    const pending = service.ask({ prompt: 'Which file?' });
    expect(openQuickInputs).toHaveLength(1);
    currentInput().accept('src/index.ts');
    await expect(pending).resolves.toBe('src/index.ts');
  });

  it('carries the placeholder to the sinks so the sidebar can render it', () => {
    const service = new UserQuestionService();
    let seen: string | undefined;
    service.addSink({
      asked: (event) => {
        seen = event.placeholder;
      },
      answered: () => undefined,
      presentsLocally: () => true,
    });
    void service.ask({ prompt: 'Which file?', placeholder: 'e.g. src/index.ts' });
    expect(seen).toBe('e.g. src/index.ts');
  });

  it('reports a dismissal as no answer rather than an empty one', async () => {
    const service = new UserQuestionService();
    const ids: string[] = [];
    service.addSink({
      asked: (event) => ids.push(event.id),
      answered: () => undefined,
      presentsLocally: () => true,
    });

    const pending = service.ask({ prompt: 'Which file?' });
    expect(service.dismiss(ids[0]!)).toBe(true);
    // undefined, not '': the tool turns this into "the user did not answer",
    // where a blank string would read to the model as an actual reply.
    await expect(pending).resolves.toBeUndefined();
    expect(service.dismiss(ids[0]!)).toBe(false);
  });

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

  it('answers sub-questions positionally and labels each line', async () => {
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({
      prompt: 'Two decisions:',
      questions: [
        { prompt: 'Version', options: ['bump', 'keep'] },
        { prompt: 'Install', options: ['open', 'skip'] },
      ],
      conversationId: 'c1',
    });
    const id = asked.mock.calls[0]?.[0].id as string;
    service.answer(id, '2 1');
    // Labelled, because "keep" and "open" alone say nothing about which
    // sub-question each one answered.
    await expect(pending).resolves.toBe('Version: keep\nInstall: open');
  });

  it('passes a reply through verbatim when it is not one index per sub-question', async () => {
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const pending = service.ask({
      prompt: 'Two decisions:',
      questions: [
        { prompt: 'Version', options: ['bump', 'keep'] },
        { prompt: 'Install', options: ['open', 'skip'] },
      ],
      conversationId: 'c1',
    });
    const id = asked.mock.calls[0]?.[0].id as string;
    service.answer(id, 'bump it but do not install');
    await expect(pending).resolves.toBe('bump it but do not install');
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
    await vi.waitFor(() =>
      expect(channel.sent.some((i) => i.text.includes('Forge asks'))).toBe(true),
    );

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
    await vi.waitFor(() =>
      expect(channel.sent.some((i) => i.text.includes('Forge asks'))).toBe(true),
    );

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

  it('returns immediately without opening a question when the conversation is unattended', async () => {
    const service = new UserQuestionService();
    const ask = vi.spyOn(service, 'ask');
    const tool = makeAskUserTool(service);
    const marker = unattendedConversations.mark('unattended-question');
    try {
      const started = Date.now();
      const result = await tool.handler(
        { prompt: 'Which file?' },
        { beforeMutate: () => undefined, conversationId: 'unattended-question' },
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result).toContain('unattended: no user present');
      expect(ask).not.toHaveBeenCalled();
    } finally {
      marker.dispose();
    }
  });

  // The failure this closes: an agent that sends `questions` with no shared
  // preamble had the whole call refused for a missing `prompt`, costing a round
  // to ask a question the user could already answer. The question is read from
  // what was sent instead.
  it('asks the sub-questions when the call sent no top-level prompt', async () => {
    const service = new UserQuestionService();
    const tool = makeAskUserTool(service);
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    const call = tool.handler(
      {
        questions: [
          { prompt: 'How to install?', options: ['now', 'later'] },
          { prompt: 'Un-pause the job?', options: ['yes', 'no'] },
        ],
      },
      { beforeMutate: () => undefined, conversationId: 'c1' },
    );

    // The box carries both sub-questions, headed by the first one rather than a
    // blank or an error string.
    const raised = asked.mock.calls[0]?.[0];
    expect(raised.prompt).toBe('How to install?');
    expect(raised.specs).toHaveLength(2);
    expect(currentInput().prompt).toContain('2) Un-pause the job?');

    const id = raised.id as string;
    expect(service.answer(id, '1 2')).toBe(true);
    await expect(call).resolves.toBe('How to install?: now\nUn-pause the job?: no');
  });

  it('shows the choice list itself when a flat call sent neither prompt nor options text', async () => {
    const service = new UserQuestionService();
    const tool = makeAskUserTool(service);
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    void tool.handler(
      { options: ['Install now', 'Install later'] },
      {
        beforeMutate: () => undefined,
        conversationId: 'c1',
      },
    );

    const raised = asked.mock.calls[0]?.[0];
    expect(raised.prompt).toContain('Install now');
    expect(raised.specs[0].options.map((o: { label: string }) => o.label)).toEqual([
      'Install now',
      'Install later',
    ]);
  });

  it('never shows an empty question when the call sent nothing usable', async () => {
    const service = new UserQuestionService();
    const tool = makeAskUserTool(service);
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined });
    void tool.handler({}, { beforeMutate: () => undefined, conversationId: 'c1' });
    expect(asked.mock.calls[0]?.[0].prompt).toContain('sent no question text');
  });
});
