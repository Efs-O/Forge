import { describe, expect, it } from 'vitest';
import { stripConversationIdentity } from '../../src/remote/RemoteReplyIdentity';

/**
 * The header the spoken channel must never carry.
 *
 * Taken from a real delivered outbox row on 2026-09-03: every voice reply began
 * by reading the conversation title -- which is derived from the sender's own
 * first prompt -- and then a shortened id, before any of the answer. Written it
 * is useful once per chat; spoken it is the question read back.
 */
describe('stripConversationIdentity', () => {
  it('removes the one-time chat label', () => {
    expect(
      stripConversationIdentity('Chat: Fix the voice path · ID: 74a…d52\n\nDone, all tests pass.'),
    ).toBe('Done, all tests pass.');
  });

  it('removes a Greek-titled label too', () => {
    const text = 'Chat: Πού είναι το αρχείο · ID: 74a…d52\n\nΕίναι στο src.';
    expect(stripConversationIdentity(text)).toBe('Είναι στο src.');
  });

  it('leaves a reply without the label untouched', () => {
    const text = 'Chat with the model about IDs later.\n\nNothing to strip here.';
    expect(stripConversationIdentity(text)).toBe(text);
  });

  /**
   * Only the leading label. A reply that quotes the pattern mid-body is prose,
   * and the anchor is what keeps it that way.
   */
  it('never strips mid-message', () => {
    const text = 'See below.\n\nChat: Something · ID: abc…def\n\nEnd.';
    expect(stripConversationIdentity(text)).toBe(text);
  });
});
