import { describe, expect, it } from 'vitest';
import { MidTurnInbox } from '../../src/agent/MidTurnInbox';

describe('MidTurnInbox', () => {
  it('drains tells in arrival order and isolates conversations', () => {
    const inbox = new MidTurnInbox();
    inbox.add('one', { id: 'a', text: 'first' });
    inbox.add('one', { id: 'b', text: 'second' });
    inbox.add('two', { id: 'c', text: 'other' });

    expect(inbox.drain('one')).toEqual([
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ]);
    expect(inbox.drain('one')).toEqual([]);
    expect(inbox.takeUndelivered('two')).toEqual([{ id: 'c', text: 'other' }]);
  });
});
