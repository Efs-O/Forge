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
  armNewConversationByDefault,
  clankerDefaultNotice,
  CLANKER_DEFAULT_EXPIRED_NOTICE,
  reconcileClankerDefault,
} from '../../src/sidebar/chatClanker';
import {
  loadSidebarSession,
  persistedToRuntime,
  runtimeToPersisted,
} from '../../src/sidebar/sessionPersistence';
import { isMinimalV1, openConversationSignature } from '../../src/sidebar/openConversationsPersistence';
import { displayTranscriptRows } from '../../src/sidebar/sessionProjections';
import { summarizeConversation } from '../../src/sidebar/hostConversationSummary';
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

describe('the owner-set expiring Clanker default', () => {
  const future = '2999-01-01T08:00';
  const creationNotice =
    'Clanker is on by default until 2999-01-01 08:00 (policy.yaml clanker.default_on_until). Its three stops still hold: deny-listed destructive shell commands, Forge guard files, a secret read followed by egress. Turn it off here with /clanker.';
  const expiredNotice =
    "Clanker's default from policy.yaml has ended, so this chat is gated again. Turn it back on with /clanker.";

  it('arms only newly created chats while the deadline is in the future and persists its source', () => {
    const created = conversation('new');
    const existing = conversation('old');
    expect(armNewConversationByDefault(created, future, Date.parse('2026-11-10T00:00'))).toBe(creationNotice);
    expect(clankerDefaultNotice(future)).toBe(creationNotice);
    expect(created.clanker).toBe(true);
    expect(created.clankerSource).toBe('policy-default');
    expect(created.messages).toEqual([]);
    expect(
      displayTranscriptRows(
        created.messages,
        created.displayDiffs,
        created.compaction,
        created.displayQuestionRecords,
        created.displayNotices,
      )[0]?.content,
    ).toBe(creationNotice);
    expect(summarizeConversation(created, false, 0)).toMatchObject({
      clanker: true,
      clankerSource: 'policy-default',
    });
    expect(existing.clanker).toBeUndefined();
    const persisted = runtimeToPersisted(
      { activeConversationId: created.id, conversations: [created], history: [] },
      { withHistory: false },
    );
    expect(persisted.conversations[0]?.clankerSource).toBe('policy-default');
    expect(persistedToRuntime(persisted.conversations[0]!).clankerSource).toBe('policy-default');
    expect(persisted.conversations[0]?.display_notices?.[0]?.message).toBe(creationNotice);
    expect(persistedToRuntime(persisted.conversations[0]!).displayNotices?.[0]?.message).toBe(creationNotice);
    expect(isMinimalV1(persisted)).toBe(true);
  });

  it('leaves new chats gated when the key is absent or already expired', () => {
    const absent = conversation('absent');
    const past = conversation('past');
    expect(armNewConversationByDefault(absent, undefined, Date.now())).toBeUndefined();
    expect(armNewConversationByDefault(past, '2026-11-09T08:00', Date.parse('2026-11-09T08:00'))).toBeUndefined();
    expect(absent.clanker).toBeUndefined();
    expect(past.clanker).toBeUndefined();
  });

  it('arms the fresh startup session too, while leaving restored sessions alone', () => {
    const fresh = loadSidebarSession(
      fakeMemento({}) as never,
      undefined,
      { models: [], active_model: null, clanker: { default_on_until: future } },
    );
    expect(fresh.conversations[0]?.clanker).toBe(true);
    expect(fresh.conversations[0]?.clankerSource).toBe('policy-default');
    expect(fresh.conversations[0]?.messages).toEqual([]);
    expect(fresh.conversations[0]?.displayNotices?.[0]?.message).toBe(creationNotice);

    const prior = conversation('prior');
    const persisted = runtimeToPersisted(
      { activeConversationId: prior.id, conversations: [prior], history: [] },
      { withHistory: false },
    );
    const workspace = fakeMemento({ 'forge.conversations.v1': persisted });
    const restored = loadSidebarSession(
      workspace as never,
      undefined,
      { models: [], active_model: null, clanker: { default_on_until: future } },
    );
    expect(restored.conversations[0]?.clanker).toBeUndefined();
  });

  it('disarms only a default-sourced chat at expiry or policy removal and returns one notice', () => {
    expect(reconcileClankerDefault(true, 'policy-default', future, Date.parse(future))).toEqual({
      clanker: false,
      source: undefined,
      notice: expiredNotice,
    });
    expect(reconcileClankerDefault(true, 'policy-default', undefined, Date.now()).notice).toBe(expiredNotice);
    expect(reconcileClankerDefault(true, undefined, undefined, Date.now())).toEqual({
      clanker: true,
      source: undefined,
    });
    expect(CLANKER_DEFAULT_EXPIRED_NOTICE).toBe(expiredNotice);
  });

  it('persists one expiry notice and clears the provenance marker atomically', () => {
    const conv = conversation('expired', true);
    conv.clankerSource = 'policy-default';
    const records = chatClankerRecords(() => conv);
    expect(records.expirePolicyDefault(conv.id, expiredNotice)).toBe(true);
    expect(records.expirePolicyDefault(conv.id, expiredNotice)).toBe(false);
    expect(conv.clanker).toBe(false);
    expect(conv.clankerSource).toBeUndefined();
    expect(conv.messages).toEqual([]);
    expect(conv.displayNotices?.map((notice) => notice.message)).toEqual([expiredNotice]);
    expect(
      displayTranscriptRows(
        conv.messages,
        conv.displayDiffs,
        conv.compaction,
        conv.displayQuestionRecords,
        conv.displayNotices,
      )[0]?.content,
    ).toBe(expiredNotice);
  });
});
