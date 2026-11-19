import { describe, expect, it } from 'vitest';
import type { MidTurnTell } from '../../src/agent/MidTurnInbox';
import {
  groupTellBatches,
  inputTextOf,
  runsAfterStop,
  sendNowOrder,
} from '../../src/sidebar/undeliveredTells';

it('preserves origin when queued agent messages become follow-up prompts', () => {
  const batches = groupTellBatches([
    { id: 'user', text: 'user words' },
    { id: 'agent', text: 'agent note', origin: { kind: 'chat' } },
  ]);
  expect(batches).toMatchObject([
    { text: 'user words', internal: false },
    { text: 'agent note', internal: false, origin: { kind: 'chat' } },
  ]);
  expect(inputTextOf(batches)).toBe('user words');
});

describe('runsAfterStop', () => {
  const sendNow = [
    { id: 'a', text: 'first' },
    { id: 'b', text: 'second', sendNow: true },
  ];

  it('runs the tells only after the interrupt "Send now" caused', () => {
    expect(runsAfterStop('interrupted', sendNow)).toBe(true);
    expect(runsAfterStop('cancelled', sendNow)).toBe(false);
    expect(runsAfterStop('interrupted', [{ id: 'a', text: 'first' }])).toBe(false);
  });
});

describe('inputTextOf', () => {
  it('returns nothing when there is no user text to restore', () => {
    expect(inputTextOf([])).toBeUndefined();
    expect(inputTextOf([{ text: 'background job exited', internal: true }])).toBeUndefined();
  });

  it("keeps only the user's own words, in order", () => {
    expect(
      inputTextOf([
        { text: 'first', internal: false },
        { text: 'background job exited', internal: true },
        { text: 'second', internal: false },
      ]),
    ).toBe('first\n\nsecond');
  });
});

describe('sendNowOrder', () => {
  const tells: MidTurnTell[] = [
    { id: 'chat', text: 'agent reply', origin: { kind: 'chat' } },
    { id: 'user1', text: 'first words', sendNow: true },
    { id: 'internal', text: 'background notice', internal: true },
    { id: 'user2', text: 'second words' },
  ];

  it("puts the user's own tells ahead of delivered and internal ones", () => {
    expect(sendNowOrder('interrupted', tells).map((tell) => tell.id)).toEqual([
      'user1',
      'user2',
      'chat',
      'internal',
    ]);
  });

  it('leaves the arrival order alone when nothing interrupted the turn', () => {
    expect(sendNowOrder('completed', tells).map((tell) => tell.id)).toEqual([
      'chat',
      'user1',
      'internal',
      'user2',
    ]);
  });
});
