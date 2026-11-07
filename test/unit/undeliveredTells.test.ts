import { describe, expect, it } from 'vitest';
import { groupTellBatches, inputTextOf, runsAfterStop } from '../../src/sidebar/undeliveredTells';

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
