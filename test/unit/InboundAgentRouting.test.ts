import { describe, expect, it } from 'vitest';
import {
  findBySession,
  link,
  rebuildIndex,
  type AgentLink,
  type AgentSender,
} from '../../src/agentLinks/chatAgentLinks';
import {
  formatMovedSessionNotice,
  resolveInboundAgentTarget,
} from '../../src/agentLinks/inboundAgentRouting';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

function chat(id: string, title = id): ConversationRuntime {
  return { id, title, createdAt: 1, updatedAt: 1, messages: [] };
}

function linkValue(sessionId: string, title = 'Source session'): AgentLink {
  return {
    kind: 'claude', sessionId, cwd: '/workspace', title,
    linkedAt: 1, lastUsedAt: 1, origin: 'user-set',
  };
}

const sender: AgentSender = {
  kind: 'claude',
  sessionId: '00000000-0000-4000-8000-000000000051',
};

function state(active: ConversationRuntime, others: ConversationRuntime[] = []): SidebarRuntime {
  return { activeConversationId: active.id, conversations: [active, ...others], history: [] };
}

describe('inbound session routing', () => {
  it('names an untitled destination as a new chat in the moved-session notice', () => {
    expect(formatMovedSessionNotice('claude', linkValue(sender.sessionId), 'Untitled chat')).toBe(
      'Claude session "Source session" moved to a new chat.',
    );
    expect(formatMovedSessionNotice('claude', linkValue(sender.sessionId), 'Review notes')).toBe(
      'Claude session "Source session" moved to chat "Review notes".',
    );
  });

  it('links an unclaimed sender to the active chat with first-inbound origin', () => {
    const active = chat('active', 'Active chat');
    const sidebar = state(active);
    rebuildIndex([]);
    const target = resolveInboundAgentTarget({
      sidebar, sender, selection: {}, workspaceRoot: '/workspace',
      createChat: () => undefined, restoreChat: () => undefined, persist: () => {},
    });
    expect(target.conversationId).toBe('active');
    expect(target.link.origin).toBe('first-inbound');
    expect(findBySession(sender.sessionId)).toBe('active');
  });

  it('refuses --to when the sender is linked to another chat and moves on --new', () => {
    rebuildIndex([]);
    const original = chat('old', 'Old chat');
    const selected = chat('selected', 'Selected chat');
    const next = chat('new', 'New chat');
    link(original, linkValue(sender.sessionId), [original]);
    const sidebar = state(original, [selected]);
    expect(() => resolveInboundAgentTarget({
      sidebar, sender, selection: { conversationId: selected.id }, workspaceRoot: '/workspace',
      createChat: () => next, restoreChat: () => undefined, persist: () => {},
    })).toThrow('Old chat');

    let persisted = false;
    const moved = resolveInboundAgentTarget({
      sidebar, sender, selection: { newChat: true }, workspaceRoot: '/workspace',
      createChat: () => next, restoreChat: () => undefined, persist: () => { persisted = true; },
    });
    expect(moved.conversationId).toBe('new');
    expect(moved.movedFrom).toEqual({ conversationId: 'old', title: 'Old chat' });
    expect(findBySession(sender.sessionId)).toBe('new');
    expect(original.agentLinks).toBeUndefined();
    expect(persisted).toBe(true);
  });
});
