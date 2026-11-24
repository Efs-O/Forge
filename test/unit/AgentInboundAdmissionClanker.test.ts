import { describe, expect, it, vi } from 'vitest';

import type { AgentSender } from '../../src/agentLinks/chatAgentLinks';
import type { PendingAgentReplies } from '../../src/agentLinks/pendingAgentReplies';
import type { BusPaths } from '../../src/agentBus/agentBus';
import type { InboxMessageOptions } from '../../src/agentBus/agentInbox';
import type { AgentRoutesDeps } from '../../src/backend/agentRoutesDeps';
import { admitInboundMessage } from '../../src/backend/agentInboundAdmission';

/**
 * A `say --new` from a linked session opens its chat through
 * `resolveInboundAgent`, not through `openBusChat`, and `openBusChat` is the only
 * other place Clanker is armed. These three rows are the whole rule: `--new` arms,
 * an addressed or default chat does not.
 */
const sender: AgentSender = {
  kind: 'claude',
  sessionId: '00000000-0000-4000-8000-000000000001',
};
const routed = {
  conversationId: 'chat-opened-by-new',
  title: 'a new chat',
  sender: { ...sender, title: 'Claude session aaf2' },
  link: {
    ...sender,
    cwd: '/workspace',
    title: 'Claude session aaf2',
    linkedAt: 1,
    lastUsedAt: 1,
    origin: 'first-inbound' as const,
  },
};

function fixture(messageOptions: InboxMessageOptions) {
  const armBusChat = vi.fn();
  const dropRecoveryReplyRoute = vi.fn();
  const resolveInboundAgent = vi.fn(async () => routed);
  const deps = {
    paths: () => ({ root: '/bus' }) as BusPaths,
    inbox: { accept: () => undefined, cancel: () => 0, release: () => true },
    workspaceRoot: '/workspace',
    pendingReplies: {
      create: () => ({ exchangeId: 'exchange-1' }),
    } as unknown as PendingAgentReplies,
    resolveInboundAgent,
    armBusChat,
    dropRecoveryReplyRoute,
  } as unknown as AgentRoutesDeps;
  return { armBusChat, resolveInboundAgent, dropRecoveryReplyRoute, deps, messageOptions };
}

describe('a sender chat and Clanker', () => {
  it('arms the chat a sender opened with --new', async () => {
    const state = fixture({ newChat: true, from: 'claude' });

    const admitted = await admitInboundMessage({
      from: 'claude',
      sender,
      messageOptions: state.messageOptions,
      deps: state.deps,
    });

    expect(state.armBusChat).toHaveBeenCalledTimes(1);
    expect(state.armBusChat).toHaveBeenCalledWith('chat-opened-by-new', 'claude');
    expect(state.resolveInboundAgent).toHaveBeenCalledWith(
      sender,
      expect.objectContaining({ newChat: true }),
    );
    expect(admitted.target?.conversationId).toBe('chat-opened-by-new');
  });

  it('does not arm the chat a sender follows up into', async () => {
    const state = fixture({ from: 'claude' });

    const admitted = await admitInboundMessage({
      from: 'claude',
      sender,
      messageOptions: state.messageOptions,
      deps: state.deps,
    });

    expect(state.armBusChat).not.toHaveBeenCalled();
    expect(admitted.target?.conversationId).toBe('chat-opened-by-new');
  });

  it('does not arm a chat the sender named with --to', async () => {
    const state = fixture({ from: 'claude', conversationId: 'chat-opened-by-new' });

    await admitInboundMessage({
      from: 'claude',
      sender,
      messageOptions: state.messageOptions,
      deps: state.deps,
    });

    expect(state.armBusChat).not.toHaveBeenCalled();
  });

  it('drops a kept recovery route when a newer sender reply is accepted', async () => {
    const state = fixture({ from: 'claude' });
    await admitInboundMessage({
      from: 'claude',
      sender,
      messageOptions: state.messageOptions,
      deps: state.deps,
    });
    expect(state.dropRecoveryReplyRoute).toHaveBeenCalledOnce();
    expect(state.dropRecoveryReplyRoute).toHaveBeenCalledWith('chat-opened-by-new');
  });

  it('still admits when the window supplies no armBusChat', async () => {
    const state = fixture({ newChat: true, from: 'claude' });
    delete (state.deps as { armBusChat?: unknown }).armBusChat;

    await expect(
      admitInboundMessage({
        from: 'claude',
        sender,
        messageOptions: state.messageOptions,
        deps: state.deps,
      }),
    ).resolves.toMatchObject({ target: { conversationId: 'chat-opened-by-new' } });
  });
});
