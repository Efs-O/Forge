import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBoardContext } from '../../src/agentMesh/meshContext';
import {
  remoteSessionAction,
  answerRemoteSessionQuestion,
  remoteSessionAnswerPath,
  sessionQuestionForReply,
} from '../../src/remote/RemoteSessionBridge';
import {
  admitRemoteSessionCommand,
  admitRemoteSessionReply,
} from '../../src/remote/remoteSessionAdmission';
import { RemoteOutboxDelivery } from '../../src/remote/RemoteOutboxDelivery';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { drainRemoteQueue, type RemoteQueueDrainDeps } from '../../src/remote/RemoteQueueDrain';
import { RemoteAgentProgress, CLOCK_INTERVAL_MS } from '../../src/remote/RemoteAgentProgress';
import { startRemoteSessionRecovery } from '../../src/remote/RemoteSessionRecovery';
import { handleAgentRemoteSessionRoute } from '../../src/backend/agentRemoteSessionRoute';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteInboundEvent, RemoteRequestRecord } from '../../src/remote/types';

const dirs: string[] = [];
afterEach(async () => {
  setBoardContext(undefined);
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-session-reply-'));
  dirs.push(dir);
  const store = new RemoteRequestStore(path.join(dir, 'state.json'));
  await store.load();
  return { dir, store };
}

function request(id: string): RemoteRequestRecord {
  return {
    id,
    dedupKey: id,
    channel: 'fake',
    chatId: 'chat-a',
    providerMessageId: 'm1',
    conversationId: 'c1',
    text: 'hello',
    sessionTarget: 'codex',
    receivedAt: Date.now(),
    senderSessionId: id,
    admittedAt: Date.now(),
    state: 'running',
    updatedAt: Date.now(),
  };
}

describe('Telegram session reply route', () => {
  it('admits an exact /codex command once and retains its Telegram origin', async () => {
    const { store } = await fixture();
    await store.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'w',
      conversationId: 'c1',
    });
    const channel = new FakeRemoteChannel();
    const event = {
      kind: 'text',
      channel: 'fake',
      chatId: 'chat-a',
      senderId: 'owner',
      providerMessageId: 'm1',
      chatType: 'private',
      receivedAt: Date.now(),
      text: '/codex hello from Telegram',
    } as Extract<RemoteInboundEvent, { kind: 'text' }>;
    const ack = vi.fn(async () => undefined);
    const deps = {
      channel,
      store,
      host: {
        createConversation: async () => ({ id: 'c1' }),
        getAgentLink: () => undefined,
        status: () => ({ conversations: [{ id: 'c1', title: 'Main' }] }),
      },
      options: {
        workspaceId: 'w',
        queueLimit: 5,
        attachmentsEnabled: false,
        acceptPdfAttachments: false,
      },
      isBusy: () => false,
      kickDrain: () => undefined,
    } as never;
    await expect(admitRemoteSessionCommand(event, 'dedup', deps, ack)).resolves.toMatchObject({
      kind: 'accepted',
    });
    expect(store.getByDedupKey('dedup')).toMatchObject({
      chatId: 'chat-a',
      text: 'hello from Telegram',
      sessionTarget: 'codex',
    });
    await expect(admitRemoteSessionCommand(event, 'dedup', deps, ack)).resolves.toMatchObject({
      kind: 'duplicate',
    });
    expect(ack).toHaveBeenCalledTimes(1);
    await expect(
      admitRemoteSessionCommand({ ...event, text: '/codexy hello' }, 'other', deps, ack),
    ).resolves.toBeUndefined();
  });

  it('routes notify and ask only to the running exchange and authenticated origin', async () => {
    const { dir, store } = await fixture();
    const id = '8e395649-705e-47f9-b499-03a36e908f50';
    await store.enqueue(request(id));
    const auth = { canDeliver: async () => true } as never;
    const kick = vi.fn();
    const available = () => true;
    await expect(
      remoteSessionAction({
        from: 'claude',
        sessionId: id,
        exchangeId: id,
        action: 'notify',
        text: 'wrong',
        store,
        auth,
        available,
        kick,
      }),
    ).resolves.toMatchObject({ kind: 'refused' });
    await expect(
      remoteSessionAction({
        from: 'codex',
        sessionId: '8e395649-705e-47f9-b499-03a36e908f51',
        exchangeId: id,
        action: 'notify',
        text: 'wrong session',
        store,
        auth,
        available,
        kick,
      }),
    ).resolves.toMatchObject({ kind: 'refused' });
    await expect(
      remoteSessionAction({
        from: 'codex',
        sessionId: id,
        exchangeId: id,
        action: 'notify',
        text: 'working',
        store,
        auth,
        available,
        kick,
      }),
    ).resolves.toEqual({ kind: 'notified' });
    const asked = await remoteSessionAction({
      from: 'codex',
      sessionId: id,
      exchangeId: id,
      action: 'ask',
      text: 'Which file?',
      store,
      auth,
      available,
      kick,
    });
    expect(asked.kind).toBe('asked');
    if (asked.kind !== 'asked') throw new Error('question was not accepted');
    expect(store.pendingOutbox().map((item) => item.chatId)).toEqual(['chat-a', 'chat-a']);
    expect(store.pendingOutbox()[1]!.text).toContain(`/answer ${asked.questionId}`);
    await expect(
      remoteSessionAction({
        from: 'codex',
        sessionId: id,
        exchangeId: id,
        action: 'ask',
        text: 'Another?',
        store,
        auth,
        available,
        kick,
      }),
    ).resolves.toMatchObject({
      kind: 'refused',
      error: expect.stringContaining('already waiting'),
    });
    await expect(
      answerRemoteSessionQuestion(store, 'fake', 'other-chat', asked.questionId, 'x', dir),
    ).resolves.toBe('missing');
    const reopened = new RemoteRequestStore(path.join(dir, 'state.json'));
    await reopened.load();
    expect(reopened.getRequest(id)?.state).toBe('unknown');
    await expect(
      answerRemoteSessionQuestion(reopened, 'fake', 'chat-a', asked.questionId, 'src/a.ts', dir),
    ).resolves.toBe('answered');
    await expect(fs.readFile(remoteSessionAnswerPath(asked.questionId, dir), 'utf8')).resolves.toBe(
      'src/a.ts',
    );
    await expect(
      answerRemoteSessionQuestion(store, 'fake', 'chat-a', asked.questionId, 'different', dir),
    ).resolves.toBe('duplicate');
    expect(kick).toHaveBeenCalledTimes(2);
  });

  it('answers a question by a reply to the message it was delivered as', async () => {
    const { store } = await fixture();
    const id = '8e395649-705e-47f9-b499-03a36e908f52';
    await store.enqueue(request(id));
    const auth = { canDeliver: async () => true } as never;
    const asked = await remoteSessionAction({
      from: 'codex',
      sessionId: id,
      exchangeId: id,
      action: 'ask',
      text: 'Keep the shim?',
      store,
      auth,
      available: () => true,
      kick: vi.fn(),
    });
    if (asked.kind !== 'asked') throw new Error('question was not accepted');
    const channel = new FakeRemoteChannel();
    const delivery = new RemoteOutboxDelivery(
      channel,
      store,
      4000,
      new AbortController().signal,
      0,
    );
    delivery.start();
    await vi.waitFor(() =>
      expect(sessionQuestionForReply(store, 'fake', 'chat-a', 'sent-1')).toBe(asked.questionId),
    );
    await delivery.stop();
    expect(channel.sent[0]!.text).toContain('Reply to this message with your answer');
    // Another chat, another message, or a command never resolve to the question.
    expect(sessionQuestionForReply(store, 'fake', 'other-chat', 'sent-1')).toBeUndefined();
    expect(sessionQuestionForReply(store, 'fake', 'chat-a', 'sent-9')).toBeUndefined();
    const event = {
      kind: 'text',
      channel: 'fake',
      chatId: 'chat-a',
      senderId: 'owner',
      providerMessageId: 'm2',
      chatType: 'private',
      receivedAt: Date.now(),
      text: 'yes',
      replyToMessageId: 'sent-9',
    } as Extract<RemoteInboundEvent, { kind: 'text' }>;
    const deps = { store } as never;
    const ack = vi.fn(async () => undefined);
    await expect(admitRemoteSessionReply(event, deps, ack)).resolves.toBeUndefined();
    await expect(
      admitRemoteSessionReply({ ...event, replyToMessageId: 'sent-1', text: '/status' }, deps, ack),
    ).resolves.toBeUndefined();
    await expect(
      admitRemoteSessionReply(
        {
          ...event,
          replyToMessageId: 'sent-1',
          attachments: [{ name: 'a.jpg', mediaType: 'image/jpeg', data: 'eA==' }],
        },
        deps,
        ack,
      ),
    ).resolves.toMatchObject({ kind: 'rejected' });
    expect(ack).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex', 'copilot'] as const)(
    'finishes a queued /%s ask with one Telegram outbox reply',
    async (target) => {
      const { store } = await fixture();
      const id = '8e395649-705e-47f9-b499-03a36e908f51';
      await store.enqueue({ ...request(id), sessionTarget: target, state: 'queued' });
      const channel = new FakeRemoteChannel();
      const label = target[0]!.toUpperCase() + target.slice(1);
      const linked = { kind: target, sessionId: `session-${target}`, title: `Forge · Main` };
      const ask = vi.fn(
        async (
          _conversationId: string,
          request: { agent: string },
          _signal: AbortSignal,
          onLinked?: (link: typeof linked) => void,
          onAccepted?: (link: typeof linked) => void,
        ) => {
          onLinked?.(linked);
          onAccepted?.(linked);
          return {
            agent: target,
            status: 'completed' as const,
            finalText: `${request.agent} answered`,
            sessionTitle: linked.title,
            subject: 'hello',
            live: false,
          };
        },
      );
      const host = {
        send: vi.fn(),
        askAgent: ask,
        getAgentLink: () => linked,
        status: () => ({ conversations: [], requestChains: [], streamingConversationIds: [] }),
      };
      const signal = new AbortController().signal;
      const progress = new RemoteAgentProgress(
        channel,
        signal,
        () => true,
        3900,
        1000,
        undefined,
        undefined,
        CLOCK_INTERVAL_MS,
      );
      await drainRemoteQueue('c1', {
        signal,
        channel,
        store,
        auth: { canDeliver: async () => true },
        host,
        progress,
        outbox: { kick: vi.fn() },
        activeConversations: new Set(),
        attachmentStore: () => undefined,
        isBusy: () => false,
      } as unknown as RemoteQueueDrainDeps);
      expect(host.send).not.toHaveBeenCalled();
      expect(ask).toHaveBeenCalledTimes(1);
      expect(channel.sent.map((item) => item.text)).toEqual(['✓ ' + label + ' received it']);
      expect(store.getRequest(id)?.state).toBe('completed');
      expect(store.pendingOutbox()).toHaveLength(1);
      expect(store.pendingOutbox()[0]!.text).toContain(`${target} answered`);
    },
  );

  it('recovers a late verdict after restart without reasking the session', async () => {
    const { dir, store } = await fixture();
    const id = '8e395649-705e-47f9-b499-03a36e908f52';
    await store.enqueue({ ...request(id), state: 'unknown' });
    await fs.mkdir(path.join(dir, 'verdicts'));
    await fs.writeFile(path.join(dir, 'verdicts', `${id}.md`), 'late answer');
    setBoardContext({ root: dir, workspace: dir, log: path.join(dir, 'exchanges.jsonl') });
    const abort = new AbortController();
    const kick = vi.fn();
    startRemoteSessionRecovery(store, 'fake', { kick } as never, abort.signal);
    await vi.waitFor(() => expect(store.getRequest(id)?.state).toBe('completed'));
    abort.abort();
    expect(store.pendingOutbox()).toHaveLength(1);
    expect(store.pendingOutbox()[0]!.text).toContain('late answer');
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('refuses a forged sender or another exchange before dispatching a bus notification', async () => {
    const dispatch = vi.fn(async () => ({ kind: 'notified' as const }));
    const deps = { dispatch };
    const sender = { kind: 'codex', sessionId: '8e395649-705e-47f9-b499-03a36e908f51' };
    await expect(
      handleAgentRemoteSessionRoute(
        { from: 'claude', sender, exchange_id: '8e395649-705e-47f9-b499-03a36e908f51', text: 'hi' },
        'notify',
        deps,
      ),
    ).rejects.toThrow('sender');
    await expect(
      handleAgentRemoteSessionRoute(
        { from: 'codex', sender, exchange_id: '../chat', text: 'hi' },
        'notify',
        deps,
      ),
    ).rejects.toThrow('exchange_id');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
