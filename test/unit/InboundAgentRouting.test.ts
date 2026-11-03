import { describe, expect, it } from 'vitest';
import {
  chatsForSession,
  findBySession,
  link,
  rebuildIndex,
  type AgentLink,
  type AgentSender,
} from '../../src/agentLinks/chatAgentLinks';
import {
  formatAlsoLinkedNotice,
  resolveInboundAgentTarget,
} from '../../src/agentLinks/inboundAgentRouting';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

function chat(id: string, title = id): ConversationRuntime {
  return { id, title, createdAt: 1, updatedAt: 1, messages: [] };
}

function linkValue(sessionId: string, title = 'Source session'): AgentLink {
  return {
    kind: 'claude',
    sessionId,
    cwd: '/workspace',
    title,
    linkedAt: 1,
    lastUsedAt: 1,
    origin: 'user-set',
  };
}

const sender: AgentSender = {
  kind: 'claude',
  sessionId: '00000000-0000-4000-8000-000000000051',
};

const otherSender: AgentSender = {
  kind: 'claude',
  sessionId: '00000000-0000-4000-8000-000000000052',
};

function state(active: ConversationRuntime, others: ConversationRuntime[] = []): SidebarRuntime {
  return { activeConversationId: active.id, conversations: [active, ...others], history: [] };
}

/** The dependency set every route needs; `persist` is counted so a test can
 *  say whether the link the route made was actually saved. */
function route(
  sidebar: SidebarRuntime,
  selection: { conversationId?: string; newChat?: boolean },
  chats: { create?: ConversationRuntime; restore?: ConversationRuntime } = {},
  persist?: () => void,
) {
  return resolveInboundAgentTarget({
    sidebar,
    sender,
    selection,
    workspaceRoot: '/workspace',
    createChat: () => chats.create,
    restoreChat: () => chats.restore,
    persist: persist ?? (() => {}),
  });
}

describe('inbound session routing', () => {
  it('names an untitled destination as a new chat in the second-chat notice', () => {
    expect(
      formatAlsoLinkedNotice('claude', linkValue(sender.sessionId), 'Untitled chat'),
    ).toContain('started a new chat as well');
    expect(formatAlsoLinkedNotice('claude', linkValue(sender.sessionId), 'Review notes')).toContain(
      'started chat "Review notes" as well',
    );
  });

  it('links an unclaimed sender to the active chat with first-inbound origin', () => {
    const active = chat('active', 'Active chat');
    const sidebar = state(active);
    rebuildIndex([]);
    const target = route(sidebar, {});
    expect(target.conversationId).toBe('active');
    expect(target.link.origin).toBe('first-inbound');
    expect(findBySession(sender.sessionId)).toBe('active');
  });

  it('after --new the session reaches its older chat with --to, and both keep their links', () => {
    // The clause AC 16 opens with: `say --new` used to move the link, so the
    // older chat could never be reached again by the session that started it.
    rebuildIndex([]);
    const older = chat('old', 'Old chat');
    const added = chat('new', 'New chat');
    link(older, linkValue(sender.sessionId));
    const sidebar = state(older, [added]);

    let persisted = 0;
    const second = route(sidebar, { newChat: true }, { create: added }, () => {
      persisted += 1;
    });
    expect(second.conversationId).toBe('new');
    expect(second.alsoLinkedFrom).toEqual({ conversationId: 'old', title: 'Old chat' });
    expect(chatsForSession(sender.sessionId).sort()).toEqual(['new', 'old']);
    expect(findBySession(sender.sessionId)).toBe('new'); // newest use wins
    expect(older.agentLinks?.claude?.sessionId).toBe(sender.sessionId); // still linked
    expect(persisted).toBe(1);

    const back = route(sidebar, { conversationId: 'old' });
    expect(back.conversationId).toBe('old');
    expect(findBySession(sender.sessionId)).toBe('old'); // `--to` makes it current again
    expect(added.agentLinks?.claude?.sessionId).toBe(sender.sessionId); // and the new one stays
  });

  it('refuses --to a chat whose link of this kind names a different session', () => {
    // The one refusal `--to` keeps. Revert the check in
    // `src/agentLinks/inboundAgentRouting.ts` and this test fails.
    rebuildIndex([]);
    const mine = chat('mine', 'My chat');
    const theirs = chat('theirs', 'Their chat');
    link(mine, linkValue(sender.sessionId));
    link(theirs, linkValue(otherSender.sessionId, 'Other session'));

    expect(() => route(state(mine, [theirs]), { conversationId: 'theirs' })).toThrow(
      'already links a different claude session',
    );
    // Refusing must not have taken the other session's chat away from it.
    expect(chatsForSession(otherSender.sessionId)).toEqual(['theirs']);
    expect(findBySession(sender.sessionId)).toBe('mine');
  });

  it('--to an open chat that holds no link links it and makes it current', () => {
    rebuildIndex([]);
    const mine = chat('mine', 'My chat');
    const free = chat('free', 'Free chat');
    link(mine, linkValue(sender.sessionId));
    const sidebar = state(mine, [free]);

    let persisted = 0;
    const target = route(sidebar, { conversationId: 'free' }, {}, () => {
      persisted += 1;
    });
    expect(target.conversationId).toBe('free');
    expect(free.agentLinks?.claude?.sessionId).toBe(sender.sessionId);
    expect(findBySession(sender.sessionId)).toBe('free');
    expect(chatsForSession(sender.sessionId).sort()).toEqual(['free', 'mine']);
    expect(persisted).toBe(1);
  });

  it('say without --to goes to the chat the session last addressed', () => {
    const older = {
      ...chat('older', 'Older chat'),
      agentLinks: { claude: { ...linkValue(sender.sessionId), lastUsedAt: 10 } },
    };
    const newer = {
      ...chat('newer', 'Newer chat'),
      agentLinks: { claude: { ...linkValue(sender.sessionId), lastUsedAt: 20 } },
    };
    rebuildIndex([newer, older]);

    expect(route(state(older, [newer]), {})).toMatchObject({
      conversationId: 'newer',
      title: 'Newer chat',
    });
  });

  it('a window that does not hold the current chat routes to its own newest chat', () => {
    // The session index is process-wide, so the chat a session last addressed
    // can belong to another window. This window must still answer for its own.
    const elsewhere = {
      ...chat('elsewhere', 'Another window'),
      agentLinks: { claude: { ...linkValue(sender.sessionId), lastUsedAt: 99 } },
    };
    const mine = {
      ...chat('mine', 'My chat'),
      agentLinks: { claude: { ...linkValue(sender.sessionId), lastUsedAt: 10 } },
    };
    rebuildIndex([elsewhere, mine]);

    const target = route(state(mine), {});
    expect(target.conversationId).toBe('mine');
    expect(findBySession(sender.sessionId)).toBe('elsewhere'); // still the current chat
  });

  it('a session whose chats are all outside this window still says the linked chat is unavailable', () => {
    rebuildIndex([
      {
        id: 'elsewhere',
        title: 'Another window',
        agentLinks: { claude: linkValue(sender.sessionId) },
      },
    ]);
    expect(() => route(state(chat('local', 'Local chat')), {})).toThrow('is unavailable');
  });
});
