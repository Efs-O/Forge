/**
 * The per-chat Clanker flag: where it is stored, what survives a save and a reload,
 * and what clears it. It replaced a window-wide `workspaceState` key, so the cases
 * that matter are the ones a window-wide flag could not answer: two chats in one
 * window, a reload that keeps one chat armed and leaves the other gated, and a chat
 * whose record was written before the flag existed, which must start gated rather
 * than inherit whatever the last chat left behind.
 */
import { describe, expect, it } from 'vitest';
import {
  chatClankerOn,
  chatClankerRecords,
  clearChatClanker,
} from '../../src/sidebar/chatClanker';
import {
  loadSidebarSession,
  persistedToRuntime,
  runtimeToPersisted,
} from '../../src/sidebar/sessionPersistence';
import { openConversationSignature } from '../../src/sidebar/openConversationsPersistence';
import {
  conversationPersistedSchema,
  type ConversationRuntime,
} from '../../src/sidebar/sessionTypes';

function conversation(id: string, clanker?: boolean): ConversationRuntime {
  return {
    id,
    title: 'Chat',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    ...(clanker === undefined ? {} : { clanker }),
  };
}

/** A memento that behaves like the real one: a `undefined` write deletes the key. */
function fakeMemento(seed: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...seed };
  return {
    get: <T>(key: string, defaultValue?: T) =>
      store[key] === undefined ? defaultValue : (store[key] as T),
    keys: () => [],
    update: (key: string, value: unknown) => {
      if (value === undefined) delete store[key];
      else store[key] = value;
    },
    setKeysForSync: () => undefined,
    store,
  };
}

describe('the flag lives on the conversation record', () => {
  it('survives a save and a reload, so arming a chat outlives the window', () => {
    const conv = conversation('chat-1', true);
    const saved = runtimeToPersisted(
      { activeConversationId: conv.id, conversations: [conv], history: [] },
      { withHistory: false },
    );
    expect(saved.conversations[0]?.clanker).toBe(true);
    const reloaded = persistedToRuntime(saved.conversations[0]!);
    expect(reloaded.clanker).toBe(true);
    // Copied, not shared: a reload must not hand the same object back to a chat that
    // has since been rewritten in place.
    expect(reloaded).not.toBe(conv);
  });

  it('clears the window-wide key an older Forge left armed, so no chat inherits it', () => {
    const memento = fakeMemento({ 'forge.clankerMode': true });
    const loaded = loadSidebarSession(memento as never);
    // Nothing reads that key any more, and a chat whose record carries no flag is
    // gated: an older window's armed mode must not come back for every tab, and a
    // key nobody reads is a mode the owner can neither see nor turn off.
    expect('forge.clankerMode' in memento.store).toBe(false);
    // And the chats this window loads are off, because their records have no flag.
    expect(loaded.conversations.some(chatClankerOn)).toBe(false);
  });

  it('changes the open-chat signature, so a save cannot skip it', () => {
    const conv = conversation('chat-1');
    const before = openConversationSignature(conv);
    conv.clanker = true;
    const armed = openConversationSignature(conv);
    expect(armed).not.toBe(before);
    clearChatClanker(conv);
    expect(openConversationSignature(conv)).not.toBe(armed);
  });

  it('a record written before the flag existed parses unchanged and starts gated', () => {
    const parsed = conversationPersistedSchema.parse({
      id: 'chat-old',
      title: 'Older Forge',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    });
    expect(parsed.clanker).toBeUndefined();
    const reloaded = persistedToRuntime(parsed);
    // Every chat starts off after this update: a record with no field is not an
    // inherited flag, and an inherited flag would have armed chats nobody confirmed.
    expect(chatClankerOn(reloaded)).toBe(false);
  });

  it('turning it off writes false rather than deleting it, so the reload says off', () => {
    const conv = conversation('chat-1', true);
    conv.clanker = false;
    const saved = runtimeToPersisted(
      { activeConversationId: conv.id, conversations: [conv], history: [] },
      { withHistory: false },
    );
    expect(saved.conversations[0]?.clanker).toBe(false);
    expect(persistedToRuntime(saved.conversations[0]!).clanker).toBe(false);
  });
});

describe('the pair the approval queue reads and writes through', () => {
  it('arms one chat and leaves every other record untouched', () => {
    const chats: Record<string, ConversationRuntime> = {
      'chat-1': conversation('chat-1'),
      'chat-2': conversation('chat-2'),
    };
    const records = chatClankerRecords((conversationId) => chats[conversationId]);
    records.write('chat-1', true);
    expect(chatClankerOn(chats['chat-1'])).toBe(true);
    // The other tab in the same window: untouched, and read as ungated. This is the
    // half the window-wide flag could not get right.
    expect(chats['chat-2'].clanker).toBeUndefined();
    expect(records.read('chat-2')).toBeUndefined();
    expect(chatClankerOn(chats['chat-2'])).toBe(false);
  });

  it('writes nothing for a chat this window cannot see, and reads it as off', () => {
    const chats: Record<string, ConversationRuntime> = { 'chat-1': conversation('chat-1') };
    const records = chatClankerRecords((conversationId) => chats[conversationId]);
    records.write('chat-gone', true);
    expect(records.read('chat-gone')).toBeUndefined();
    // The flag is stored where the chat is: arming a conversation this window does
    // not hold cannot make the next one answer calls it never earned.
    expect(Object.keys(chats)).toEqual(['chat-1']);
  });

  it('/clear clears the flag with the history it was armed for', () => {
    const conv = conversation('chat-1', true);
    clearChatClanker(conv);
    expect(chatClankerOn(conv)).toBe(false);
    // Written as `false`, not deleted, so the signature sees the change and the save
    // that follows `/clear` cannot skip the flag.
    expect(conv.clanker).toBe(false);
  });
});
