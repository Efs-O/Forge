import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { admitRemoteSessionCommand } from '../../src/remote/remoteSessionAdmission';
import { remoteSessionAskFromText } from '../../src/remote/remoteSessionTellCommands';
import { handleRemoteCommand } from '../../src/remote/RemoteCommandHandler';
import { drainRemoteQueue, type RemoteQueueDrainDeps } from '../../src/remote/RemoteQueueDrain';
import { RemoteAgentProgress, CLOCK_INTERVAL_MS } from '../../src/remote/RemoteAgentProgress';
import { MAX_AGENT_SESSION_MESSAGE_CHARS } from '../../src/remote/remoteSessionTellCommands';
import type { AskAgentResult } from '../../src/agentLinks/askAgentService';
import type { AgentLink } from '../../src/agentLinks/chatAgentLinks';
import type { RemoteInboundEvent } from '../../src/remote/types';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup(options: { bound?: boolean; sendError?: string } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-linked-ask-'));
  dirs.push(dir);
  const store = new RemoteRequestStore(path.join(dir, 'state.json'));
  await store.load();
  if (options.bound !== false)
    await store.setBinding({
      channel: 'fake',
      chatId: 'chat-a',
      workspaceId: 'workspace',
      conversationId: 'c1',
    });
  const channel = new FakeRemoteChannel();
  channel.sendError = options.sendError;
  const links = new Map<string, AgentLink>();
  const askAgent = vi.fn(
    async (
      conversationId: string,
      request: { agent: 'claude' | 'codex' | 'copilot'; message: string },
      _signal: AbortSignal,
      onSessionLinked?: (link: AgentLink) => void,
      onAccepted?: (link: AgentLink) => void,
    ): Promise<AskAgentResult> => {
      const link: AgentLink = {
        kind: request.agent,
        sessionId: `session-${request.agent}`,
        cwd: 'C:/workspace',
        title: 'Forge · Main',
        linkedAt: 1,
        lastUsedAt: 2,
        origin: 'forge-created',
      };
      links.set(request.agent, link);
      onSessionLinked?.(link);
      onAccepted?.(link);
      return {
        agent: request.agent,
        status: 'completed',
        finalText: `${request.agent} reply`,
        sessionTitle: link.title,
        subject: request.message,
        live: false,
      };
    },
  );
  const host = {
    askAgent,
    getAgentLink: (_conversationId: string, kind: string) => links.get(kind),
    status: () => ({
      conversations: [{ id: 'c1', title: 'Main' }],
      requestChains: [],
      streamingConversationIds: [],
    }),
  };
  const onError = vi.fn();
  const kickDrain = vi.fn();
  const promptDeps = {
    channel,
    store,
    host,
    options: {
      workspaceId: 'workspace',
      queueLimit: 5,
      attachmentsEnabled: false,
      acceptPdfAttachments: false,
    },
    isBusy: () => false,
    kickDrain,
    onError,
  };
  const event = (text: string, id = 'm1') =>
    ({
      kind: 'text',
      channel: 'fake',
      chatId: 'chat-a',
      senderId: 'owner',
      providerMessageId: id,
      chatType: 'private',
      receivedAt: Date.now(),
      text,
    }) as Extract<RemoteInboundEvent, { kind: 'text' }>;
  const drain = async (conversationId = 'c1') => {
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
    await drainRemoteQueue(conversationId, {
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
  };
  return { store, channel, links, askAgent, host, onError, promptDeps, event, drain, kickDrain };
}

async function admit(state: Awaited<ReturnType<typeof setup>>, text: string, key = 'request-1') {
  return admitRemoteSessionCommand(
    state.event(text, key),
    key,
    state.promptDeps as never,
    (chatId, message) => state.channel.send(chatId, message),
    state.onError,
  );
}

describe('Telegram linked-agent asks', () => {
  it('/tell admits a durable request and creates the missing bound-chat link when drained', async () => {
    const state = await setup();
    await expect(admit(state, '/tell codex build 2 failed')).resolves.toMatchObject({
      kind: 'accepted',
    });
    expect(state.channel.sent[0]?.text).toBe('→ Codex (Forge · Main): build 2 failed');
    expect(state.store.queued('c1')[0]).toMatchObject({
      sessionTarget: 'codex',
      text: 'build 2 failed',
    });
    expect(state.askAgent).not.toHaveBeenCalled();
    await state.drain();
    expect(state.askAgent).toHaveBeenCalledWith(
      'c1',
      { agent: 'codex', message: 'build 2 failed' },
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
    expect(state.links.get('codex')?.sessionId).toBe('session-codex');
    expect(state.channel.sent.map((item) => item.text)).toEqual([
      '→ Codex (Forge · Main): build 2 failed',
      '✓ Codex received it',
    ]);
    expect(state.store.pendingOutbox()[0]?.text).toContain(
      'Codex (Forge · Main) says: codex reply',
    );
  });

  it('refuses /tell without a bound conversation', async () => {
    const state = await setup({ bound: false });
    await expect(admit(state, '/tell claude hello')).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'no conversation is bound',
    });
    expect(state.store.queued()).toEqual([]);
    expect(state.askAgent).not.toHaveBeenCalled();
  });

  it('keeps empty-message and message-size usage refusals', async () => {
    const state = await setup();
    await expect(admit(state, '/tell codex')).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'usage: /tell <claude|codex|copilot> <message>',
    });
    const tooLong = 'x'.repeat(MAX_AGENT_SESSION_MESSAGE_CHARS + 1);
    await expect(admit(state, `/tell claude ${tooLong}`, 'too-long')).resolves.toMatchObject({
      kind: 'rejected',
      reason: expect.stringContaining(String(MAX_AGENT_SESSION_MESSAGE_CHARS + 1)),
    });
    expect(state.store.queued()).toEqual([]);
  });

  it('reports a delivery failure as a new failure message and failed request', async () => {
    const state = await setup();
    state.askAgent.mockResolvedValueOnce({
      agent: 'claude',
      status: 'failed',
      finalText: '',
      error: 'authentication expired',
      sessionTitle: 'Forge · Main',
      subject: 'check',
      live: false,
    });
    await admit(state, '/claude check auth', 'failure');
    await state.drain();
    expect(state.channel.sent.map((item) => item.text)).toContain('✗ authentication expired');
    expect(state.store.getByDedupKey('failure')?.state).toBe('failed');
  });

  it('keeps an admitted command completed when its arrow acknowledgement fails', async () => {
    const state = await setup({ sendError: 'telegram transport is down' });
    await expect(admit(state, '/tell claude ship it', 'ack-failure')).resolves.toMatchObject({
      kind: 'accepted',
    });
    expect(state.onError).toHaveBeenCalledWith(
      expect.stringContaining('telegram transport is down'),
    );
    await expect(admit(state, '/tell claude ship it', 'ack-failure')).resolves.toMatchObject({
      kind: 'duplicate',
    });
    expect(state.store.queued('c1')).toHaveLength(1);
    expect(state.kickDrain).toHaveBeenCalledOnce();
  });

  it('keeps durable admission when reporting an acknowledgement failure also fails', async () => {
    const state = await setup({ sendError: 'telegram transport is down' });
    state.onError.mockImplementation(() => {
      throw new Error('logger failed');
    });
    await expect(admit(state, '/tell copilot once', 'report-failure')).resolves.toMatchObject({
      kind: 'accepted',
    });
    expect(state.store.queued('c1')).toHaveLength(1);
  });

  it('does not enqueue a duplicate update id twice', async () => {
    const state = await setup();
    await admit(state, '/codex once', 'same-update');
    await expect(admit(state, '/codex once', 'same-update')).resolves.toMatchObject({
      kind: 'duplicate',
    });
    expect(state.store.queued('c1')).toHaveLength(1);
    expect(state.kickDrain).toHaveBeenCalledOnce();
  });

  it('refuses an unknown control-event outcome instead of replaying it', async () => {
    const state = await setup();
    expect(await state.store.beginControlEvent('control-crash')).toBe('admitted');
    await expect(
      handleRemoteCommand(
        state.event('/not-a-command'),
        {
          channel: state.channel,
          store: state.store,
          host: state.host,
          signal: new AbortController().signal,
        } as never,
        'control-crash',
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'previous command outcome is unknown; resend it',
    });
    expect(state.askAgent).not.toHaveBeenCalled();
  });

  it('leaves unrelated commands to the rest of the routing chain', async () => {
    const state = await setup();
    await expect(admit(state, '/status')).resolves.toBeUndefined();
    expect(remoteSessionAskFromText('/codexy hi')).toBeUndefined();
  });

  it('keeps session asks behind the owner authentication gate', async () => {
    const state = await setup({ bound: false });
    const secrets = {
      get: async () => 'someone-else',
      store: async () => undefined,
      delete: async () => undefined,
      onDidChange: vi.fn(),
    } as unknown as vscode.SecretStorage;
    const auth = new RemoteAuth(secrets);
    const host = {
      createConversation: vi.fn(async () => ({ id: 'c1', title: 'Remote' })),
      restoreConversation: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      addApprovalSink: () => ({ dispose: () => undefined }),
      addQuestionSink: () => ({ dispose: () => undefined }),
      answerQuestion: () => false,
      status: () => ({
        activeConversationId: 'c1',
        conversations: [],
        requestChains: [],
        streamingConversationIds: [],
      }),
    } as never;
    const controller = new RemoteController(state.channel, state.store, auth, host, {
      workspaceId: 'workspace',
      queueLimit: 5,
      maxMessageChars: 12_000,
      rateLimitPerMinute: 30,
    });
    await controller.start();
    try {
      await expect(
        state.channel.emit({
          ...state.event('/tell claude do something'),
          senderId: 'stranger',
          chatId: 'private-chat',
        }),
      ).resolves.toMatchObject({ kind: 'rejected', reason: 'sender is not paired' });
      expect(state.store.queued()).toEqual([]);
    } finally {
      await controller.stop();
    }
  });
});
