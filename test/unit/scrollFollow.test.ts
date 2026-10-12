import { describe, expect, it } from 'vitest';
import { isScrollUpIntent, nextScrolledUp } from '../../webview-ui/src/scrollFollow';

describe('nextScrolledUp', () => {
  it('does not treat programmatic upward scroll movement as reader intent', () => {
    expect(nextScrolledUp(false, { distFromBottom: 4 })).toBe(false);
  });

  it('keeps a reader opt-out while content grows below the viewport', () => {
    expect(nextScrolledUp(true, { distFromBottom: 300 })).toBe(true);
  });

  it('does not relatch when layout correction moves scrollTop upward', () => {
    expect(nextScrolledUp(false, { distFromBottom: 40 })).toBe(false);
  });

  it('keeps opt-out until the reader actually reaches the end', () => {
    expect(nextScrolledUp(true, { distFromBottom: 30 })).toBe(true);
  });

  it('unlatches at the very bottom', () => {
    expect(nextScrolledUp(true, { distFromBottom: 0 })).toBe(false);
  });

  it('does not latch when a shrink clamps scrollTop to the bottom', () => {
    expect(nextScrolledUp(false, { distFromBottom: 0 })).toBe(false);
  });

  it('classifies wheel and touch direction as explicit intent', () => {
    expect(isScrollUpIntent({ kind: 'wheel', delta: -1 })).toBe(true);
    expect(isScrollUpIntent({ kind: 'wheel', delta: 1 })).toBe(false);
    expect(isScrollUpIntent({ kind: 'touch', delta: -20 })).toBe(true);
  });

  it('classifies scrollbar and keyboard navigation', () => {
    expect(isScrollUpIntent({ kind: 'scrollbar', delta: -1 })).toBe(true);
    expect(isScrollUpIntent({ kind: 'keyboard', key: 'PageUp' })).toBe(true);
    expect(isScrollUpIntent({ kind: 'keyboard', key: 'ArrowDown' })).toBe(false);
    expect(isScrollUpIntent({ kind: 'keyboard', key: ' ', shiftKey: true })).toBe(true);
  });
});
