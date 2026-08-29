import { describe, expect, it } from 'vitest';
import { RequestChainLifecycle } from '../../src/sidebar/RequestChainLifecycle';

describe('RequestChainLifecycle', () => {
  it('admits one owner per conversation while independent conversations remain free', () => {
    const lifecycle = new RequestChainLifecycle();
    const first = lifecycle.reserve('a', () => false);
    expect(first.kind).toBe('reserved');
    expect(lifecycle.reserve('a', () => false)).toEqual({ kind: 'busy', conversationId: 'a' });
    expect(lifecycle.reserve('b', () => false).kind).toBe('reserved');
  });

  it('does not reserve when the existing turn lifecycle reports busy', () => {
    const lifecycle = new RequestChainLifecycle();
    expect(lifecycle.reserve('a', () => true)).toEqual({ kind: 'busy', conversationId: 'a' });
    expect(lifecycle.currentEpoch('a')).toBe(0);
  });

  it('advances only when a reservation is accepted and releases by fencing token', () => {
    const lifecycle = new RequestChainLifecycle();
    const admitted = lifecycle.reserve('a', () => false);
    if (admitted.kind !== 'reserved') throw new Error('expected reservation');
    expect(lifecycle.currentEpoch('a')).toBe(0);
    const chain = lifecycle.accept(admitted.reservation);
    expect(chain.userIntentEpoch).toBe(1);
    expect(lifecycle.isCurrent(chain)).toBe(true);
    lifecycle.release({ ...admitted.reservation, token: 'wrong' });
    expect(lifecycle.isReserved('a')).toBe(true);
    lifecycle.release(admitted.reservation);
    expect(lifecycle.isReserved('a')).toBe(false);
  });
});
