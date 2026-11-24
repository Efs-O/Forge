import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { readVerdictArtifact } from '../../src/agentMesh/verdictArtifact';
import { deriveLatestState } from '../../src/agentMesh/deliveryState';
import {
  EXCHANGES_LOG_NAME,
  readEvents,
} from '../../src/agentMesh/exchangeLog';
import {
  makeAgentReplyLifecycle,
  recordAcceptedInboundReply,
} from '../../src/agentLinks/agentReplyLifecycle';
import type { AskAgentRuntime } from '../../src/agentLinks/askAgentService';
import {
  PENDING_AGENT_REPLY_TTL_MS,
  PendingAgentReplies,
} from '../../src/agentLinks/pendingAgentReplies';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { AgentLink, AgentSenderMetadata } from '../../src/agentLinks/chatAgentLinks';

const sender: AgentSenderMetadata = {
  kind: 'claude',
  sessionId: '00000000-0000-4000-8000-000000000101',
  title: 'Claude review',
};

const linked: AgentLink = {
  ...sender,
  cwd: '/workspace',
  linkedAt: 1,
  lastUsedAt: 1,
  origin: 'first-inbound',
};

function fixture(root: string, live: boolean) {
  const pending = new PendingAgentReplies(root, () => 10_000, 90001);
  const notices: string[] = [];
  let recoveryReplyRoute: import('../../src/agentLinks/pendingAgentReplies').RecoveryReplyRoute | undefined;
  const sendLive = vi.fn(async (_kind, _link, _text, _signal, purpose) => {
    expect(purpose).toBe('reply');
    return { status: 'completed' as const, finalText: '' };
  });
  const runtime = {
    isLive: vi.fn(async () => live),
    sendLive,
  } as unknown as AskAgentRuntime;
  const facade = {
    status: () => ({ conversations: [{ id: 'chat-1', title: 'Review chat' }] }),
    getAgentLink: () => linked,
    showConversationNotice: (_id: string, notice: string) => notices.push(notice),
    restoreConversation: vi.fn(async () => ({ id: 'chat-1', title: 'Review chat' })),
    getConversation: () => ({
      id: 'chat-1',
      recoveryReplyRoute,
      messages: [{ role: 'user', content: 'Owner follow-up', createdAt: 10_001 }],
    }),
    setRecoveryReplyRoute: (_id: string, route: typeof recoveryReplyRoute) => {
      recoveryReplyRoute = route;
      return true;
    },
  } as unknown as ForgeHostFacade;
  const lifecycle = makeAgentReplyLifecycle({
    root,
    workspaceRoot: '/workspace',
    pending,
    runtime,
    getFacade: () => facade,
    showWarning: (message) => notices.push(message),
  });
  return { pending, lifecycle, notices, sendLive, facade, getRecoveryReplyRoute: () => recoveryReplyRoute };
}

/** The events one exchange got, in the order they were written. */
function eventsFor(root: string, exchangeId: string) {
  return readEvents(path.join(root, EXCHANGES_LOG_NAME)).filter(
    (event) => event.exchangeId === exchangeId,
  );
}

describe('inbound agent reply lifecycle', () => {
  it('records a turn ended by stop as cancelled, not as completed work (audit F8)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-stopped-'));
    try {
      const state = fixture(root, true);
      const record = state.pending.create(sender, 'chat-1', '/workspace');
      await recordAcceptedInboundReply(root, record);
      await state.lifecycle.onAgentTurnFinished(
        { pendingReplyId: record.exchangeId, targetConversationId: 'chat-1', sender },
        { kind: 'cancelled', error: 'no final answer' },
      );
      // The verdict event used to say `completed` whatever the turn did, so a
      // reader could not tell work that finished from work the user stopped.
      const events = eventsFor(root, record.exchangeId);
      expect(deriveLatestState(events)).toBe('cancelled');
      expect(events.at(-1)?.type).toBe('verdict');
      expect(events.at(-1)?.detail).toContain('cancelled');
      // The answer text still says what happened to the sender that asked.
      expect(state.sendLive.mock.calls[0]?.[2]).toContain('Forge cancelled');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('records a turn interrupted by a steer as cancelled too (audit F8)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-steered-'));
    try {
      const state = fixture(root, true);
      const record = state.pending.create(sender, 'chat-1', '/workspace');
      await recordAcceptedInboundReply(root, record);
      await state.lifecycle.onAgentTurnFinished(
        { pendingReplyId: record.exchangeId, targetConversationId: 'chat-1', sender },
        { kind: 'interrupted', error: 'steered' },
      );
      expect(deriveLatestState(eventsFor(root, record.exchangeId))).toBe('cancelled');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a finished turn completed, with the delivery it actually got', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-completed-'));
    try {
      const state = fixture(root, true);
      const record = state.pending.create(sender, 'chat-1', '/workspace');
      await recordAcceptedInboundReply(root, record);
      await state.lifecycle.onAgentTurnFinished(
        { pendingReplyId: record.exchangeId, targetConversationId: 'chat-1', sender },
        { kind: 'completed', finalText: 'Forge answer' },
      );
      const events = eventsFor(root, record.exchangeId);
      expect(deriveLatestState(events)).toBe('completed');
      expect(events.at(-1)?.detail).toBe('reply delivered to the live sender session');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('records a message withdrawn with cancel, instead of leaving it accepted (audit F8)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-cancelled-'));
    try {
      const state = fixture(root, false);
      const record = state.pending.create(sender, 'chat-1', '/workspace');
      await recordAcceptedInboundReply(root, record);
      await state.lifecycle.onAgentTurnCancelled({
        pendingReplyId: record.exchangeId,
        targetConversationId: 'chat-1',
        sender,
      });
      // The pending record is gone either way; the log used to say nothing, so
      // the exchange stayed `accepted` forever and looked like work still
      // queued in a chat that had nothing queued.
      const events = eventsFor(root, record.exchangeId);
      expect(deriveLatestState(events)).toBe('cancelled');
      expect(events.at(-1)?.detail).toContain('cancel');
      expect(state.pending.list()).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sends a start receipt and delivers the final reply through the live runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-live-'));
    try {
      const state = fixture(root, true);
      const record = state.pending.create(sender, 'chat-1', '/workspace');
      await state.lifecycle.onAgentTurnStarted({
        pendingReplyId: record.exchangeId,
        targetConversationId: 'chat-1',
        sender,
      });
      expect(fs.existsSync(path.join(root, 'outbox', `${record.exchangeId}-received.md`))).toBe(
        false,
      );
      await state.lifecycle.onAgentTurnFinished(
        { pendingReplyId: record.exchangeId, targetConversationId: 'chat-1', sender },
        { kind: 'completed', finalText: 'Forge answer' },
      );
      expect(state.sendLive).toHaveBeenCalledOnce();
      expect(state.pending.list()).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sends a visible completion message when a completed turn has no final text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-empty-'));
    try {
      const state = fixture(root, true);
      const record = state.pending.create(sender, 'chat-1', '/workspace');
      await state.lifecycle.onAgentTurnFinished(
        { pendingReplyId: record.exchangeId, targetConversationId: 'chat-1', sender },
        { kind: 'completed', finalText: '' },
      );
      expect(state.sendLive.mock.calls[0]?.[2]).toBe(
        'Forge (chat "Review chat") finished without a final answer.',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an offline reply as a readable verdict and recovers an owner-dead turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-offline-'));
    try {
      const state = fixture(root, false);
      const record = state.pending.create(sender, 'chat-1', '/workspace');
      state.pending.markRunning(record.exchangeId);
      const lifecycle = makeAgentReplyLifecycle({
        root,
        workspaceRoot: '/workspace',
        pending: state.pending,
        runtime: {
          isLive: vi.fn(async () => false),
          sendLive: state.sendLive,
        } as unknown as AskAgentRuntime,
        getFacade: () => state.facade,
        isOwnerAlive: () => false,
        showWarning: (message) => state.notices.push(message),
      });
      await lifecycle.recover();
      expect(state.facade.restoreConversation).toHaveBeenCalledWith('chat-1', { activate: false });
      expect(state.sendLive).not.toHaveBeenCalled();
      const paths = { root, inbox: '', outbox: '', endpoint: '', script: '' };
      expect(readVerdictArtifact(paths, record.exchangeId, 'claude')).toContain(
        'Forge restarted before answering.',
      );
      expect(eventsFor(root, record.exchangeId).at(-1)?.detail).toBe(
        'turn failed (Forge restarted before answering); retained for read-verdict',
      );
      expect(state.getRecoveryReplyRoute()).toEqual({
        exchangeId: record.exchangeId,
        sender,
        conversationId: 'chat-1',
        workspace: '/workspace',
        createdAt: record.createdAt,
      });
      expect(state.notices).toContain(
        'Forge restarted before answering. The next message you send in this chat will send its answer back to the Claude session "Claude review".',
      );
      expect(() =>
        readVerdictArtifact(
          paths,
          record.exchangeId,
          'claude',
          '00000000-0000-4000-8000-000000000199',
        ),
      ).toThrow('session and exchange');
      expect(state.pending.list()).toEqual([]);
      expect(state.notices.some((notice) => notice.includes('not seen live'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses a kept recovery route once and records the resumed answer against its exchange', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-resumed-'));
    try {
      const state = fixture(root, false);
      const original = state.pending.create(sender, 'chat-1', '/workspace');
      state.pending.markRunning(original.exchangeId);
      await makeAgentReplyLifecycle({
        root,
        workspaceRoot: '/workspace',
        pending: state.pending,
        runtime: {
          isLive: vi.fn(async () => false),
          sendLive: state.sendLive,
        } as unknown as AskAgentRuntime,
        getFacade: () => state.facade,
        isOwnerAlive: () => false,
        showWarning: (message) => state.notices.push(message),
      }).recover();
      await state.lifecycle.onConversationTurnFinished('chat-1', {
        kind: 'completed',
        finalText: 'Finished plan',
      });
      expect(state.getRecoveryReplyRoute()).toBeUndefined();
      expect(readVerdictArtifact({ root, inbox: '', outbox: '', endpoint: '', script: '' }, original.exchangeId, 'claude')).toBe('Finished plan\n');
      expect(eventsFor(root, original.exchangeId).at(-1)).toMatchObject({
        exchangeId: original.exchangeId,
        type: 'verdict',
        eventId: `recovery-verdict-${original.exchangeId}`,
      });
      await state.lifecycle.onConversationTurnFinished('chat-1', {
        kind: 'completed',
        finalText: 'A second turn',
      });
      expect(readVerdictArtifact({ root, inbox: '', outbox: '', endpoint: '', script: '' }, original.exchangeId, 'claude')).toBe('Finished plan\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sends the usual cancelled outcome through a kept recovery route', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-resumed-cancel-'));
    try {
      const state = fixture(root, true);
      const original = state.pending.create(sender, 'chat-1', '/workspace');
      state.pending.markRunning(original.exchangeId);
      await makeAgentReplyLifecycle({
        root,
        workspaceRoot: '/workspace',
        pending: state.pending,
        runtime: { isLive: vi.fn(async () => false), sendLive: state.sendLive } as unknown as AskAgentRuntime,
        getFacade: () => state.facade,
        isOwnerAlive: () => false,
        showWarning: (message) => state.notices.push(message),
      }).recover();
      await state.lifecycle.onConversationTurnFinished('chat-1', { kind: 'cancelled' });
      expect(state.sendLive.mock.calls.at(-1)?.[2]).toBe('Forge (chat "Review chat") replied:\n\nForge cancelled: no final answer');
      expect(state.getRecoveryReplyRoute()).toBeUndefined();
      expect(
        readVerdictArtifact(
          { root, inbox: '', outbox: '', endpoint: '', script: '' },
          original.exchangeId,
          'claude',
        ),
      ).toBe('Forge cancelled: no final answer\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an expired recovery route and a route associated with another chat', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-route-refusal-'));
    try {
      const state = fixture(root, false);
      const expiredPending = new PendingAgentReplies(root, () => PENDING_AGENT_REPLY_TTL_MS, 90001);
      const expiredLifecycle = makeAgentReplyLifecycle({
        root,
        workspaceRoot: '/workspace',
        pending: expiredPending,
        runtime: { isLive: vi.fn(async () => false), sendLive: state.sendLive } as unknown as AskAgentRuntime,
        getFacade: () => state.facade,
        showWarning: (message) => state.notices.push(message),
      });
      state.facade.setRecoveryReplyRoute('chat-1', {
        exchangeId: '00000000-0000-4000-8000-000000000303',
        sender,
        conversationId: 'chat-1',
        workspace: '/workspace',
        createdAt: 0,
      });
      await expiredLifecycle.onConversationTurnFinished('chat-1', {
        kind: 'completed',
        finalText: 'expired',
      });
      expect(state.getRecoveryReplyRoute()).toBeUndefined();
      expect(state.sendLive).not.toHaveBeenCalled();

      state.facade.setRecoveryReplyRoute('chat-1', {
        exchangeId: '00000000-0000-4000-8000-000000000304',
        sender,
        conversationId: 'another-chat',
        workspace: '/workspace',
        createdAt: PENDING_AGENT_REPLY_TTL_MS,
      });
      await state.lifecycle.onConversationTurnFinished('chat-1', {
        kind: 'completed',
        finalText: 'misrouted',
      });
      expect(state.getRecoveryReplyRoute()).toBeUndefined();
      expect(state.sendLive).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips another workspace and warns for an unknown chat without stopping recovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-workspace-'));
    try {
      const state = fixture(root, false);
      const foreign = state.pending.create(sender, 'chat-1', '/workspace-b');
      const unknown = state.pending.create(sender, 'missing-chat', '/workspace');
      const warnings: string[] = [];
      const lifecycle = makeAgentReplyLifecycle({
        root,
        workspaceRoot: '/workspace',
        pending: state.pending,
        runtime: {
          isLive: vi.fn(async () => false),
          sendLive: state.sendLive,
        } as unknown as AskAgentRuntime,
        getFacade: () => state.facade,
        isOwnerAlive: () => false,
        showWarning: (message) => warnings.push(message),
      });
      await lifecycle.recover();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('missing-chat');
      expect(new Set(state.pending.list().map((record) => record.exchangeId))).toEqual(
        new Set([foreign.exchangeId, unknown.exchangeId]),
      );
      expect(state.facade.restoreConversation).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /** A window starting now, with the session live again: the same bus folder,
   *  a runtime that can reach the session, and nothing else. */
  function startingWindow(
    root: string,
    state: ReturnType<typeof fixture>,
    sendLive = state.sendLive,
    live = true,
  ) {
    return makeAgentReplyLifecycle({
      root,
      workspaceRoot: '/workspace',
      pending: state.pending,
      runtime: {
        isLive: vi.fn(async () => live),
        sendLive,
      } as unknown as AskAgentRuntime,
      getFacade: () => state.facade,
      showWarning: (message) => state.notices.push(message),
    });
  }

  /** The state a session that never saw its answer leaves behind: the accepted
   *  row, the retained artifact, and the verdict event saying it was kept. */
  async function retainedFor(
    state: ReturnType<typeof fixture>,
    root: string,
  ): Promise<string> {
    const record = state.pending.create(sender, 'chat-1', '/workspace');
    await recordAcceptedInboundReply(root, record);
    await state.lifecycle.onAgentTurnFinished(
      { pendingReplyId: record.exchangeId, targetConversationId: 'chat-1', sender },
      { kind: 'failed', error: 'Forge restarted before answering' },
    );
    return record.exchangeId;
  }

  it('announces a retained answer to the session this window links, at start-up', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-announce-'));
    try {
      const state = fixture(root, false);
      const exchangeId = await retainedFor(state, root);
      expect(state.sendLive).not.toHaveBeenCalled();
      await startingWindow(root, state).announceWaitingVerdicts();
      expect(state.sendLive).toHaveBeenCalledTimes(1);
      // The same sentence the client prints, so the two paths cannot drift.
      expect(state.sendLive.mock.calls[0]?.[2]).toBe(
        `An answer is waiting for you from chat "Review chat" (exchange ${exchangeId}), not seen live. Read it with: forge.sh read-verdict claude ${exchangeId}`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a waiting answer alone when the link here names a different session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-announce-foreign-'));
    try {
      const state = fixture(root, false);
      await retainedFor(state, root);
      // Another window holds this session now, or the chat moved to a different
      // Claude session: either way this window cannot reach the one to tell.
      state.facade.getAgentLink = vi.fn(() => ({
        ...linked,
        sessionId: '00000000-0000-4000-8000-000000000202',
      })) as unknown as ForgeHostFacade['getAgentLink'];
      await startingWindow(root, state).announceWaitingVerdicts();
      expect(state.sendLive).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('attempts a start-up notice once and stays silent when the delivery fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-reply-announce-fails-'));
    try {
      const state = fixture(root, false);
      await retainedFor(state, root);
      const sendLive = vi.fn(async () => {
        throw new Error('the session refused');
      });
      // Not thrown out of the start-up task: the routes announce the same answer
      // on every call the session makes, so a failed attempt here is nothing.
      await expect(
        startingWindow(root, state, sendLive).announceWaitingVerdicts(),
      ).resolves.toBeUndefined();
      expect(sendLive).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
