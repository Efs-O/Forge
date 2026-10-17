import { describe, expect, it } from 'vitest';
import { MidTurnInbox } from '../../src/agent/MidTurnInbox';

describe('MidTurnInbox', () => {
  it('drains tells in arrival order and isolates conversations', () => {
    const inbox = new MidTurnInbox();
    inbox.add('one', { id: 'a', text: 'first' });
    inbox.add('one', { id: 'b', text: 'second' });
    inbox.add('two', { id: 'c', text: 'other' });

    expect(inbox.drain('one')).toEqual([
      { id: 'a', text: 'first', createdAt: expect.any(Number) },
      { id: 'b', text: 'second', createdAt: expect.any(Number) },
    ]);
    expect(inbox.drain('one')).toEqual([]);
    expect(inbox.takeUndelivered('two')).toEqual([
      { id: 'c', text: 'other', createdAt: expect.any(Number) },
    ]);
  });

  it('withdraws only the named tell, and refuses once a drain has taken it', () => {
    const inbox = new MidTurnInbox();
    inbox.add('one', { id: 'a', text: 'first' });
    inbox.add('one', { id: 'b', text: 'second' });

    expect(inbox.remove('one', 'a')).toBe(true);
    expect(inbox.remove('one', 'a')).toBe(false);
    expect(inbox.remove('two', 'b')).toBe(false);
    expect(inbox.drain('one')).toEqual([
      { id: 'b', text: 'second', createdAt: expect.any(Number) },
    ]);
    expect(inbox.remove('one', 'b')).toBe(false);
  });

  it('holds a send-now tell, and those queued with it, back from a tool-round drain', () => {
    const inbox = new MidTurnInbox();
    inbox.add('one', { id: 'a', text: 'first' });
    inbox.add('one', { id: 'b', text: 'second' });

    expect(inbox.markSendNow('one', 'b')).toBe(true);
    expect(inbox.markSendNow('two', 'b')).toBe(false);
    expect(inbox.drain('one')).toEqual([]);
    expect(inbox.takeUndelivered('one')).toEqual([
      { id: 'a', text: 'first', createdAt: expect.any(Number) },
      { id: 'b', text: 'second', sendNow: true, createdAt: expect.any(Number) },
    ]);
    expect(inbox.markSendNow('one', 'b')).toBe(false);
  });
});
