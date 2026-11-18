import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInbox, type BusTurnEnd, type InboxHost, type InboxMessageOptions } from '../../src/agentBus/agentInbox';
import { forgeInboundPrompt } from '../../src/agentBus/busContent';
import { readVerdictArtifact } from '../../src/agentMesh/verdictArtifact';
import { makeAgentReplyLifecycle } from '../../src/agentLinks/agentReplyLifecycle';
import { PendingAgentReplies } from '../../src/agentLinks/pendingAgentReplies';
import type { AgentSenderMetadata } from '../../src/agentLinks/chatAgentLinks';
import type { AskAgentRuntime } from '../../src/agentLinks/askAgentService';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import type { ForgeRequestOutcome } from '../../src/sidebar/turnOutcome';
import {
  notifyConversationSettled,
  subscribeConversationSettled,
} from '../../src/sidebar/workerChatWake';
import { createAgentBusMidTurnReplies } from '../../src/vscode/agentMessagingSetup';

const sender: AgentSenderMetadata = {
  kind: 'claude',
  sessionId: '00000000-0000-4000-8000-000000000101',
  title: 'Claude review',
};
const temporaryRoots: string[] = [];
const inboxes: AgentInbox[] = [];
const replyHandlers: { dispose(): void }[] = [];
const settledSubscriptions: { dispose(): void }[] = [];

afterEach(() => {
  for (const inbox of inboxes.splice(0)) inbox.dispose();
  for (const handlers of replyHandlers.splice(0)) handlers.dispose();
  for (const subscription of settledSubscriptions.splice(0)) subscription.dispose();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function queuedInbox(): AgentInbox {
  const host: InboxHost = {
    laneOf: (options) => options?.targetConversationId,
    isBusy: () => true,
    submit: async () => ({ kind: 'completed' }),
    warn: () => {},
  };
  const inbox = new AgentInbox(host, 60_000);
  inboxes.push(inbox);
  return inbox;
}

function acceptSender(inbox: AgentInbox, target: string, pendingReplyId: string): void {
  inbox.accept(
    forgeInboundPrompt('claude', 'Review the patch.', sender),
    'claude',
    false,
    { sender, targetConversationId: target, pendingReplyId },
  );
}

function fakeHandlers(inbox: AgentInbox, emitHostActivity = vi.fn()) {
  const started = vi.fn();
  const finished = vi.fn();
  const facade = { emitHostActivity } as unknown as ForgeHostFacade;
  const handlers = createAgentBusMidTurnReplies({
    inbox,
    getFacade: () => facade,
    replyLifecycle: {
      onAgentTurnStarted: (options: InboxMessageOptions) => started(options),
      onAgentTurnFinished: async (options: InboxMessageOptions, end: BusTurnEnd) => {
        finished(options, end);
      },
    },
  });
  replyHandlers.push(handlers);
  return { handlers, started, finished, facade, emitHostActivity };
}

describe('claimed agent-bus replies', () => {
  it('starts the durable reply at claim and mirrors the shared Telegram activity text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claimed-agent-reply-'));
    temporaryRoots.push(root);
    const pending = new PendingAgentReplies(root);
    const record = pending.create(sender, 'chat-1', '/workspace');
    const showConversationNotice = vi.fn();
    const emitHostActivity = vi.fn();
    const facade = {
      status: () => ({ conversations: [{ id: 'chat-1', title: 'Review chat' }] }),
      showConversationNotice,
      emitHostActivity,
    } as unknown as ForgeHostFacade;
    const lifecycle = makeAgentReplyLifecycle({
      root,
      workspaceRoot: '/workspace',
      pending,
      runtime: {
        isLive: vi.fn(async () => false),
        sendLive: vi.fn(),
      } as unknown as AskAgentRuntime,
      getFacade: () => facade,
      showWarning: vi.fn(),
    });
    const inbox = queuedInbox();
    acceptSender(inbox, 'chat-1', record.exchangeId);
    const handlers = createAgentBusMidTurnReplies({
      inbox,
      getFacade: () => facade,
      replyLifecycle: lifecycle,
    });
    replyHandlers.push(handlers);

    const claimed = await handlers.source('chat-1');

    expect(claimed.messages).toEqual([
      expect.objectContaining({ content: expect.stringContaining('Review the patch.'), midTurn: true }),
    ]);
    expect(pending.list()).toMatchObject([{ exchangeId: record.exchangeId, state: 'running' }]);
    expect(showConversationNotice).toHaveBeenCalledWith(
      'chat-1',
      '✓ delivered to Claude · Claude review',
    );
    expect(emitHostActivity).toHaveBeenCalledWith({
      conversationId: 'chat-1',
      suppressProgress: true,
      text: 'Claude (Claude review) says: Review the patch.',
    });
  });

  it.each([
    ['completed', { kind: 'completed', finalText: 'final answer' }, { kind: 'completed', finalText: 'final answer' }],
    ['failed', { kind: 'failed', error: 'provider failed', finalText: 'partial' }, { kind: 'failed', error: 'provider failed', finalText: 'partial' }],
    ['cancelled', { kind: 'cancelled', finalText: 'partial' }, { kind: 'cancelled', finalText: 'partial' }],
    ['interrupted', { kind: 'interrupted', finalText: 'partial' }, { kind: 'interrupted', finalText: 'partial' }],
  ] as const)('settles a claimed reply with the chain’s %s outcome', async (_kind, rawOutcome, expected) => {
    const inbox = queuedInbox();
    acceptSender(inbox, 'chat-1', 'reply-1');
    const { handlers, finished } = fakeHandlers(inbox);
    const outcome = rawOutcome as ForgeRequestOutcome;
    await handlers.source('chat-1');

    await handlers.settled('chat-1', outcome);

    expect(finished).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({ pendingReplyId: 'reply-1' }),
      expected,
    );
  });

  it('gives every sender message claimed into one turn the same final answer once', async () => {
    const inbox = queuedInbox();
    acceptSender(inbox, 'chat-1', 'reply-1');
    acceptSender(inbox, 'chat-1', 'reply-2');
    const { handlers, started, finished } = fakeHandlers(inbox);
    const answer: ForgeRequestOutcome = { kind: 'completed', finalText: 'shared answer' };
    const claimed = await handlers.source('chat-1');

    await handlers.settled('chat-1', answer);

    expect(claimed.messages).toHaveLength(2);
    expect(started).toHaveBeenCalledTimes(2);
    expect(finished).toHaveBeenCalledTimes(2);
    expect(finished).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pendingReplyId: 'reply-1' }),
      { kind: 'completed', finalText: 'shared answer' },
    );
    expect(finished).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pendingReplyId: 'reply-2' }),
      { kind: 'completed', finalText: 'shared answer' },
    );
  });

  it('finishes a claimed reply from the shared conversation-settled event', async () => {
    const inbox = queuedInbox();
    acceptSender(inbox, 'chat-1', 'reply-1');
    const { handlers, finished } = fakeHandlers(inbox);
    settledSubscriptions.push(subscribeConversationSettled(handlers.settled));
    await handlers.source('chat-1');

    await notifyConversationSettled('chat-1', {
      kind: 'completed',
      finalText: 'answer from the running turn',
    });

    expect(finished).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({ pendingReplyId: 'reply-1' }),
      { kind: 'completed', finalText: 'answer from the running turn' },
    );
  });

  it('settles claimed replies only for the conversation whose chain ended', async () => {
    const inbox = queuedInbox();
    acceptSender(inbox, 'chat-A', 'reply-A');
    acceptSender(inbox, 'chat-B', 'reply-B');
    const { handlers, finished } = fakeHandlers(inbox);
    await handlers.source('chat-A');
    await handlers.source('chat-B');

    await handlers.settled('chat-A', { kind: 'completed', finalText: 'answer A' });

    expect(finished).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({ pendingReplyId: 'reply-A', targetConversationId: 'chat-A' }),
      { kind: 'completed', finalText: 'answer A' },
    );
  });

  it('recovers a claimed running reply after its owner process dies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claimed-agent-recovery-'));
    temporaryRoots.push(root);
    const pending = new PendingAgentReplies(root);
    const record = pending.create(sender, 'chat-1', '/workspace');
    const facade = {
      status: () => ({ conversations: [{ id: 'chat-1', title: 'Review chat' }] }),
      getAgentLink: () => undefined,
      showConversationNotice: vi.fn(),
      restoreConversation: vi.fn(async () => ({ id: 'chat-1' })),
      emitHostActivity: vi.fn(),
    } as unknown as ForgeHostFacade;
    const lifecycle = makeAgentReplyLifecycle({
      root,
      workspaceRoot: '/workspace',
      pending,
      runtime: {
        isLive: vi.fn(async () => false),
        sendLive: vi.fn(),
      } as unknown as AskAgentRuntime,
      getFacade: () => facade,
      isOwnerAlive: () => false,
      showWarning: vi.fn(),
    });
    const inbox = queuedInbox();
    acceptSender(inbox, 'chat-1', record.exchangeId);
    const handlers = createAgentBusMidTurnReplies({
      inbox,
      getFacade: () => facade,
      replyLifecycle: lifecycle,
    });
    replyHandlers.push(handlers);
    await handlers.source('chat-1');
    expect(pending.list()).toMatchObject([{ exchangeId: record.exchangeId, state: 'running' }]);

    await lifecycle.recover();

    const paths = { root, inbox: '', outbox: '', endpoint: '', script: '' };
    expect(readVerdictArtifact(paths, record.exchangeId, 'claude')).toContain(
      'Forge restarted before answering.',
    );
    expect(pending.list()).toEqual([]);
    // A slow runner, not a slow product: everything this test waits on is a handful
    // of small file writes in one temp folder. The GitHub windows runner timed it
    // out at the 5 s default while the rest of the suite had the machine; the
    // assertions are unchanged, only the ceiling around them.
  }, 20_000);
});
