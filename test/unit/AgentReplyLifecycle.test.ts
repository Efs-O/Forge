import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { readVerdictArtifact } from '../../src/agentMesh/verdictArtifact';
import { makeAgentReplyLifecycle } from '../../src/agentLinks/agentReplyLifecycle';
import type { AskAgentRuntime } from '../../src/agentLinks/askAgentService';
import { PendingAgentReplies } from '../../src/agentLinks/pendingAgentReplies';
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
  } as unknown as ForgeHostFacade;
  const lifecycle = makeAgentReplyLifecycle({
    root,
    workspaceRoot: '/workspace',
    pending,
    runtime,
    getFacade: () => facade,
    showWarning: (message) => notices.push(message),
  });
  return { pending, lifecycle, notices, sendLive, facade };
}

describe('inbound agent reply lifecycle', () => {
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
});
