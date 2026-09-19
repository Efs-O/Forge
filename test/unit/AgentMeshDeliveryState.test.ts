import { describe, expect, it } from 'vitest';
import {
  canTransition,
  deriveLatestState,
  isTerminal,
  rendersAsQueued,
  type ExchangeState,
} from '../../src/agentMesh/deliveryState';

describe('delivery state machine (§2)', () => {
  it('a transport exit advances only to accepted', () => {
    expect(canTransition('created', 'accepted')).toBe(true);
    // A bare exit code must never jump straight to started/completed.
    expect(canTransition('created', 'started')).toBe(false);
    expect(canTransition('created', 'completed')).toBe(false);
    expect(canTransition('accepted', 'completed')).toBe(false);
  });

  it('the owned-session path reaches started and completed', () => {
    expect(canTransition('accepted', 'started')).toBe(true);
    expect(canTransition('started', 'completed')).toBe(true);
  });

  it('queued states render as queued, never delivered', () => {
    expect(rendersAsQueued('created')).toBe(true);
    expect(rendersAsQueued('accepted')).toBe(true);
    expect(rendersAsQueued('observed')).toBe(true);
    expect(rendersAsQueued('started')).toBe(false);
    expect(rendersAsQueued('completed')).toBe(false);
  });

  it('terminal states are the compaction-eligible set (M8)', () => {
    for (const s of [
      'completed',
      'rejected',
      'timeout',
      'cancelled',
      'crashed',
      'recovered',
      'context_lost',
    ] as ExchangeState[]) {
      expect(isTerminal(s)).toBe(true);
    }
    // unknown and stalled are NOT terminal: a receipt can still resolve them.
    expect(isTerminal('unknown')).toBe(false);
    expect(isTerminal('stalled')).toBe(false);
    expect(isTerminal('started')).toBe(false);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('completed', 'started')).toBe(false);
    expect(canTransition('rejected', 'accepted')).toBe(false);
    expect(canTransition('timeout', 'completed')).toBe(false);
    expect(canTransition('started', 'accepted')).toBe(false);
  });

  it('derives the latest state and skips duplicate event ids', () => {
    const events = [
      { state: 'created' as ExchangeState, eventId: 'e1' },
      { state: 'accepted' as ExchangeState, eventId: 'e2' },
      { state: 'accepted' as ExchangeState, eventId: 'e2' }, // duplicate: skipped
      { state: 'started' as ExchangeState, eventId: 'e3' },
      { state: 'completed' as ExchangeState, eventId: 'e4' },
    ];
    expect(deriveLatestState(events)).toBe('completed');
    expect(deriveLatestState([])).toBeUndefined();
  });
});
