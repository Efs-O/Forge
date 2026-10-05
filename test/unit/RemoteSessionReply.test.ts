import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBoardContext, setMeshOrchestrator } from '../../src/agentMesh/meshContext';
import type { MeshOrchestrator } from '../../src/agentMesh/meshOrchestrator';
import { askRemoteSession, waitForRemoteVerdict } from '../../src/remote/RemoteSessionAsk';
import { remoteSessionAction, answerRemoteSessionQuestion, remoteSessionAnswerPath } from '../../src/remote/RemoteSessionBridge';
import { admitRemoteSessionCommand } from '../../src/remote/remoteSessionAdmission';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { drainRemoteQueue, type RemoteQueueDrainDeps } from '../../src/remote/RemoteQueueDrain';
import { RemoteAgentProgress, CLOCK_INTERVAL_MS } from '../../src/remote/RemoteAgentProgress';
import { startRemoteSessionRecovery } from '../../src/remote/RemoteSessionRecovery';
import { handleAgentRemoteSessionRoute } from '../../src/backend/agentRemoteSessionRoute';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteInboundEvent, RemoteRequestRecord } from '../../src/remote/types';

const dirs: string[] = [];
afterEach(async () => {
  setMeshOrchestrator(undefined);
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
    id, dedupKey: id, channel: 'fake', chatId: 'chat-a', providerMessageId: 'm1',
    conversationId: 'c1', text: 'hello', sessionTarget: 'codex', receivedAt: Date.now(),
    admittedAt: Date.now(), state: 'running', updatedAt: Date.now(),
  };
}

describe('Telegram session reply route', () => {
  it('observes an owned Claude turn and passes its final text to the outbox caller', async () => {
    const ask = vi.fn(async () => ({ status: 'completed' as const, finalText: 'Hello from Claude' }));
    setMeshOrchestrator({ resolveAdapter: async () => ({ observesTurns: true }), ask } as unknown as MeshOrchestrator);
    const answer = await askRemoteSession('claude', 'hello', 'request-1', new AbortController().signal);
    expect(answer).toBe('Hello from Claude');
    expect(ask.mock.calls[0]![1]).toContain('remote-notify claude request-1');
    expect(ask.mock.calls[0]![1]).toContain('remote-ask claude request-1');
  });

  it.each(['codex', 'claude'] as const)('uses the remote request id for a user-opened %s verdict', async (target) => {
    const { dir } = await fixture();
    await fs.mkdir(path.join(dir, 'verdicts'));
    const tell = vi.fn(async (_to: string, _message: string, options: { exchangeId: string }) => {
      await fs.writeFile(path.join(dir, 'verdicts', `${options.exchangeId}.md`), 'Codex answer');
      return { exchangeId: options.exchangeId, to: target, observing: false };
    });
    setBoardContext({ root: dir, workspace: dir, log: path.join(dir, 'exchanges.jsonl') });
    setMeshOrchestrator({ resolveAdapter: async () => ({ observesTurns: false }), tell } as unknown as MeshOrchestrator);
    await expect(askRemoteSession(target, 'hello', 'request-2', new AbortController().signal)).resolves.toBe('Codex answer');
    expect(tell.mock.calls[0]![2]).toEqual({ expectsReply: true, exchangeId: 'request-2' });
  });

  it('does not claim success on a missing verdict or an aborted wait', async () => {
    const { dir } = await fixture();
    await expect(waitForRemoteVerdict(dir, 'missing', new AbortController().signal, 1)).rejects.toThrow('no answer');
    const aborted = new AbortController();
    aborted.abort();
    await expect(waitForRemoteVerdict(dir, 'missing', aborted.signal, 1)).rejects.toThrow('interrupted');
  });

  it('admits an exact /codex command once and retains its Telegram origin', async () => {
    const { store } = await fixture();
    const channel = new FakeRemoteChannel();
    const event = {
      kind: 'text', channel: 'fake', chatId: 'chat-a', senderId: 'owner',
      providerMessageId: 'm1', chatType: 'private', receivedAt: Date.now(),
      text: '/codex hello from Telegram',
    } as Extract<RemoteInboundEvent, { kind: 'text' }>;
    const ack = vi.fn(async () => undefined);
    const deps = {
      channel, store, host: { createConversation: async () => ({ id: 'c1' }) },
      options: { workspaceId: 'w', queueLimit: 5, attachmentsEnabled: false, acceptPdfAttachments: false },
      isBusy: () => false, kickDrain: () => undefined,
    } as never;
    await expect(admitRemoteSessionCommand(event, 'dedup', deps, ack)).resolves.toMatchObject({ kind: 'accepted' });
    expect(store.getByDedupKey('dedup')).toMatchObject({ chatId: 'chat-a', text: 'hello from Telegram', sessionTarget: 'codex' });
    await expect(admitRemoteSessionCommand(event, 'dedup', deps, ack)).resolves.toMatchObject({ kind: 'duplicate' });
    expect(ack).toHaveBeenCalledTimes(1);
    await expect(admitRemoteSessionCommand({ ...event, text: '/codexy hello' }, 'other', deps, ack)).resolves.toBeUndefined();
  });

  it('routes notify and ask only to the running exchange and authenticated origin', async () => {
    const { dir, store } = await fixture();
    const id = '8e395649-705e-47f9-b499-03a36e908f50';
    await store.enqueue(request(id));
    const auth = { canDeliver: async () => true } as never;
    const kick = vi.fn();
    const available = () => true;
    await expect(remoteSessionAction({ from: 'claude', exchangeId: id, action: 'notify', text: 'wrong', store, auth, available, kick })).resolves.toMatchObject({ kind: 'refused' });
    await expect(remoteSessionAction({ from: 'codex', exchangeId: id, action: 'notify', text: 'working', store, auth, available, kick })).resolves.toEqual({ kind: 'notified' });
    const asked = await remoteSessionAction({ from: 'codex', exchangeId: id, action: 'ask', text: 'Which file?', store, auth, available, kick });
    expect(asked.kind).toBe('asked');
    if (asked.kind !== 'asked') throw new Error('question was not accepted');
    expect(store.pendingOutbox().map((item) => item.chatId)).toEqual(['chat-a', 'chat-a']);
    expect(store.pendingOutbox()[1]!.text).toContain(`/answer ${asked.questionId}`);
    await expect(remoteSessionAction({ from: 'codex', exchangeId: id, action: 'ask', text: 'Another?', store, auth, available, kick })).resolves.toMatchObject({ kind: 'refused', error: expect.stringContaining('already waiting') });
    await expect(answerRemoteSessionQuestion(store, 'fake', 'other-chat', asked.questionId, 'x', dir)).resolves.toBe('missing');
    const reopened = new RemoteRequestStore(path.join(dir, 'state.json'));
    await reopened.load();
    expect(reopened.getRequest(id)?.state).toBe('unknown');
    await expect(answerRemoteSessionQuestion(reopened, 'fake', 'chat-a', asked.questionId, 'src/a.ts', dir)).resolves.toBe('answered');
    await expect(fs.readFile(remoteSessionAnswerPath(asked.questionId, dir), 'utf8')).resolves.toBe('src/a.ts');
    await expect(answerRemoteSessionQuestion(store, 'fake', 'chat-a', asked.questionId, 'different', dir)).resolves.toBe('duplicate');
    expect(kick).toHaveBeenCalledTimes(2);
  });

  it.each(['claude', 'codex', 'copilot'] as const)(
    'finishes a queued /%s ask with one Telegram outbox reply',
    async (target) => {
      const { store } = await fixture();
      const id = '8e395649-705e-47f9-b499-03a36e908f51';
      await store.enqueue({ ...request(id), sessionTarget: target, state: 'queued' });
      const channel = new FakeRemoteChannel();
      const host = { send: vi.fn(), status: () => ({ conversations: [], requestChains: [], streamingConversationIds: [] }) };
      const ask = vi.fn(async () => ({ status: 'completed' as const, finalText: `${target} answered` }));
      setMeshOrchestrator({ resolveAdapter: async () => ({ observesTurns: true }), ask } as unknown as MeshOrchestrator);
      const signal = new AbortController().signal;
      const progress = new RemoteAgentProgress(channel, signal, () => true, 3900, 1000, undefined, undefined, CLOCK_INTERVAL_MS);
      await drainRemoteQueue('c1', {
        signal, channel, store, auth: { canDeliver: async () => true }, host,
        progress, outbox: { kick: vi.fn() }, activeConversations: new Set(),
        attachmentStore: () => undefined, isBusy: () => false,
      } as unknown as RemoteQueueDrainDeps);
      expect(host.send).not.toHaveBeenCalled();
      expect(ask).toHaveBeenCalledTimes(1);
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
    const deps = { validateFrom: async (from: string) =>
      from === 'codex' ? { ok: true as const } : { ok: false as const, error: 'not joined' }, dispatch };
    await expect(handleAgentRemoteSessionRoute({ from: 'claude', exchange_id: '8e395649-705e-47f9-b499-03a36e908f51', text: 'hi' }, 'notify', deps)).rejects.toThrow('not joined');
    await expect(handleAgentRemoteSessionRoute({ from: 'codex', exchange_id: '../chat', text: 'hi' }, 'notify', deps)).rejects.toThrow('exchange_id');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
