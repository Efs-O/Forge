/**
 * The "Forge" chip's data: which open chats exchange `message_chat` messages.
 *
 * Most criteria run through `tabMetasFromSession`, the one projection that calls
 * the helper, so the optional `messagedChats` key is pinned where the webview
 * reads it. The helper is called directly only for shapes the projection cannot
 * carry (a self-message, a non-user turn, an array-content turn).
 */
import { describe, expect, it } from 'vitest';
import {
  formatChatMessage,
  messagedChatsByConversation,
} from '../../src/sidebar/chatMessageText';
import { tabMetasFromSession } from '../../src/sidebar/sessionProjections';
import type { SidebarRuntime } from '../../src/sidebar/sessionTypes';

/** The shape `message_chat` writes: 8 hex units plus the rest of the 8-4-4-4-12 id (36 chars). */
function chatId(prefix: string, second = '0000'): string {
  return `${prefix}-${second}-4000-8000-000000000000`;
}

const A = { id: chatId('aaaaaaaa'), title: 'A title' };
const B = { id: chatId('bbbbbbbb'), title: 'B title' };
const C = { id: chatId('cccccccc'), title: 'C title' };

interface TestConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: { role: string; content: unknown }[];
}

function conversation(
  source: { id: string; title: string },
  ...messages: { role: string; content: unknown }[]
): TestConversation {
  return { id: source.id, title: source.title, createdAt: 1, updatedAt: 2, messages };
}

function session(...conversations: TestConversation[]): SidebarRuntime {
  return {
    activeConversationId: conversations[0]?.id ?? '',
    conversations,
    history: [],
  } as unknown as SidebarRuntime;
}

/** The tell a receiving chat persists: the sender's short title and an id prefix (chatMessageResolver). */
function tell(sender: { id: string; title: string }, body = 'hi'): string {
  return formatChatMessage(sender.title, sender.id.slice(0, 8), body);
}

describe('messaged chats behind the header "Forge" chip', () => {
  it('links both sides of one message, and leaves an unrelated chat without the key (acceptance 1)', () => {
    const inB = conversation(B, { role: 'user', content: tell(A) });
    const metas = tabMetasFromSession(session(conversation(A), inB, conversation(C)));
    expect(metas[0]!.messagedChats).toEqual([{ id: B.id, title: 'B title' }]);
    expect(metas[1]!.messagedChats).toEqual([{ id: A.id, title: 'A title' }]);
    expect(metas[2]).not.toHaveProperty('messagedChats');
  });

  it('adds nothing while the other chat is closed (acceptance 2)', () => {
    const aHolds = conversation(A, { role: 'user', content: tell(B) });
    // B is not in `conversations`, so its id prefix names no open chat.
    expect(tabMetasFromSession(session(aHolds))[0]).not.toHaveProperty('messagedChats');
    // Reopen B and the chip appears on both sides.
    const both = tabMetasFromSession(session(aHolds, conversation(B)));
    expect(both[0]!.messagedChats).toEqual([{ id: B.id, title: 'B title' }]);
    expect(both[1]!.messagedChats).toEqual([{ id: A.id, title: 'A title' }]);
  });

  it('adds nothing when the id prefix is ambiguous between two open chats (acceptance 3)', () => {
    const twin1 = { id: chatId('deadbeef', '1111'), title: 'Twin one' };
    const twin2 = { id: chatId('deadbeef', '2222'), title: 'Twin two' };
    expect(twin2.id.slice(0, 8)).toBe(twin1.id.slice(0, 8));
    const metas = tabMetasFromSession(
      session(
        conversation(B, { role: 'user', content: formatChatMessage('Twin one', 'deadbeef', 'hi') }),
        conversation(twin1),
        conversation(twin2),
      ),
    );
    expect(metas[0]).not.toHaveProperty('messagedChats');
    expect(metas[1]).not.toHaveProperty('messagedChats');
    expect(metas[2]).not.toHaveProperty('messagedChats');
  });

  it('reads every tell in one merged user message, in conversation order (acceptance 4)', () => {
    const merged = `${tell(A, 'one')}\n\n${tell(C, 'two')}`;
    const inB = { role: 'user', content: merged };
    const metas = tabMetasFromSession(session(conversation(A), conversation(B, inB), conversation(C)));
    expect(metas[1]!.messagedChats).toEqual([
      { id: A.id, title: 'A title' },
      { id: C.id, title: 'C title' },
    ]);
    // Both other chats list B, and each list follows the conversation order.
    expect(metas[0]!.messagedChats).toEqual([{ id: B.id, title: 'B title' }]);
    expect(metas[2]!.messagedChats).toEqual([{ id: B.id, title: 'B title' }]);

    const reordered = tabMetasFromSession(
      session(conversation(C), conversation(B, inB), conversation(A)),
    );
    expect(reordered[1]!.messagedChats).toEqual([
      { id: C.id, title: 'C title' },
      { id: A.id, title: 'A title' },
    ]);
  });

  it('counts the persisted 0.17.73-74 legacy form (acceptance 5)', () => {
    const sender = { id: chatId('08fb1bcd'), title: 'Claude: Meeting room A. More title text' };
    const senderId = sender.id.slice(0, 8);
    const legacy =
      `[message_chat from #4 ${JSON.stringify(sender.title)} (id ${senderId})]\n` +
      'Please review this.\n\n' +
      `(Answer with message_chat to ${JSON.stringify(senderId)} only if a reply is needed; do not reply just to acknowledge.)`;
    const metas = tabMetasFromSession(
      session(conversation(sender), conversation(B, { role: 'user', content: legacy })),
    );
    expect(metas[0]!.messagedChats).toEqual([{ id: B.id, title: 'B title' }]);
    expect(metas[1]!.messagedChats).toEqual([
      { id: sender.id, title: 'Claude: Meeting room A. More title text' },
    ]);
  });

  it('adds nothing for a message from a chat that is not open here (acceptance 6)', () => {
    const metas = tabMetasFromSession(
      session(
        conversation(A),
        conversation(B, { role: 'user', content: formatChatMessage('Elsewhere', 'ffffffff', 'hi') }),
      ),
    );
    expect(metas[0]).not.toHaveProperty('messagedChats');
    expect(metas[1]).not.toHaveProperty('messagedChats');
  });
});

describe('messagedChatsByConversation on its own', () => {
  it('never lists a chat as its own messaged chat', () => {
    const map = messagedChatsByConversation([
      conversation(A, { role: 'user', content: tell(A) }),
      conversation(B),
    ]);
    expect(map.size).toBe(0);
  });

  it('skips turns that are not user messages and content that is not a string', () => {
    const map = messagedChatsByConversation([
      conversation(A),
      conversation(B, { role: 'assistant', content: tell(A) }),
      conversation(C, { role: 'user', content: [{ type: 'text', text: tell(A) }] }),
    ]);
    expect(map.size).toBe(0);
  });

  it('lists a chat with no messages of its own once the other side holds the tell', () => {
    const map = messagedChatsByConversation([conversation(A), conversation(B, { role: 'user', content: tell(A) })]);
    expect([...map.keys()]).toEqual([A.id, B.id]);
    expect(map.get(A.id)).toEqual([{ id: B.id, title: 'B title' }]);
    expect(map.get(B.id)).toEqual([{ id: A.id, title: 'A title' }]);
  });

  it('carries the display title, not the stored one', () => {
    const legacyPlaceholder = { id: chatId('abababab'), title: 'New chat' };
    const map = messagedChatsByConversation([
      conversation(legacyPlaceholder),
      conversation(B, { role: 'user', content: tell(legacyPlaceholder) }),
    ]);
    expect(map.get(B.id)).toEqual([{ id: legacyPlaceholder.id, title: 'Untitled chat' }]);
  });
});
