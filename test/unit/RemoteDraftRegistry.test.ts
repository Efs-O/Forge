import { describe, expect, it } from 'vitest';
import { RemoteDraftRegistry } from '../../src/remote/RemoteDraftRegistry';

/**
 * Phase 2: the association a Telegram Stop update must resolve against.
 *
 * A Stop update carries a chat id and a draft id and nothing else, so this map
 * is the only thing standing between a stray button press and cancelling the
 * wrong conversation. Requiring both halves of the key to match is the
 * invariant; one live draft per conversation is the second.
 */
describe('RemoteDraftRegistry', () => {
  it('matches only when both the chat and the draft id match', () => {
    const registry = new RemoteDraftRegistry();
    registry.register({ chatId: 'chat-1', conversationId: 'c1', draftId: 4 });

    expect(registry.find('chat-1', 4)?.conversationId).toBe('c1');
    // Same draft id in another chat: foreign, must not match.
    expect(registry.find('chat-2', 4)).toBeUndefined();
    // Same chat, an id that was never opened here: stale.
    expect(registry.find('chat-1', 5)).toBeUndefined();
  });

  it('keeps one live draft per conversation, replacing the earlier id', () => {
    const registry = new RemoteDraftRegistry();
    registry.register({ chatId: 'chat-1', conversationId: 'c1', draftId: 1 });
    registry.register({ chatId: 'chat-1', conversationId: 'c1', draftId: 2 });

    expect(registry.size).toBe(1);
    // The abandoned id must stop being a cancel path for the live turn.
    expect(registry.find('chat-1', 1)).toBeUndefined();
    expect(registry.find('chat-1', 2)?.conversationId).toBe('c1');
  });

  it('drops every entry for a conversation once the turn ends', () => {
    const registry = new RemoteDraftRegistry();
    registry.register({ chatId: 'chat-1', conversationId: 'c1', draftId: 1 });
    registry.register({ chatId: 'chat-2', conversationId: 'c1', draftId: 2 });
    registry.register({ chatId: 'chat-3', conversationId: 'c2', draftId: 3 });

    registry.forgetConversation('c1');

    expect(registry.size).toBe(1);
    expect(registry.find('chat-3', 3)?.conversationId).toBe('c2');
  });

  it('drops every entry for a chat when that chat is unpaired or reset', () => {
    const registry = new RemoteDraftRegistry();
    registry.register({ chatId: 'chat-1', conversationId: 'c1', draftId: 1 });
    registry.register({ chatId: 'chat-1', conversationId: 'c2', draftId: 2 });
    registry.register({ chatId: 'chat-9', conversationId: 'c3', draftId: 3 });

    registry.forgetChat('chat-1');

    expect(registry.size).toBe(1);
    expect(registry.find('chat-9', 3)?.conversationId).toBe('c3');
  });

  it('claims a draft atomically, so a second claim of the same draft finds nothing', () => {
    // The handler must claim before it awaits. A find plus a separate forget
    // leaves a window across the await, and two Stop updates delivered back to
    // back would both see the entry and both cancel: the single-threaded event
    // loop does not help when check and removal are separated by an await.
    const registry = new RemoteDraftRegistry();
    registry.register({ chatId: 'chat-1', conversationId: 'c1', draftId: 4 });

    const claimed = registry.take('chat-1', 4);
    expect(claimed?.conversationId).toBe('c1');
    // Gone in the same step it was read: nothing left for the second delivery.
    expect(registry.find('chat-1', 4)).toBeUndefined();
    expect(registry.take('chat-1', 4)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('claims only the exact match, leaving a live draft untouched', () => {
    const registry = new RemoteDraftRegistry();
    registry.register({ chatId: 'chat-1', conversationId: 'c1', draftId: 4 });

    // A stale or foreign id must not consume the live entry, or the real Stop
    // would arrive to find nothing and the turn would keep running.
    expect(registry.take('chat-2', 4)).toBeUndefined();
    expect(registry.take('chat-1', 5)).toBeUndefined();
    expect(registry.find('chat-1', 4)?.conversationId).toBe('c1');
  });
});
