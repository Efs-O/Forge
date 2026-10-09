import { describe, expect, it } from 'vitest';
import { nextScrolledUp } from '../../webview-ui/src/scrollFollow';

describe('nextScrolledUp', () => {
  it('latches on a small upward move near the bottom (smooth wheel frame)', () => {
    expect(nextScrolledUp(false, { scrollTop: 996, lastScrollTop: 1000, distFromBottom: 4 })).toBe(true);
  });

  it('stays latched while the reader keeps scrolling up within the threshold', () => {
    expect(nextScrolledUp(true, { scrollTop: 980, lastScrollTop: 990, distFromBottom: 20 })).toBe(true);
  });

  it('does not unlatch when content grows under a reader who scrolled up', () => {
    expect(nextScrolledUp(true, { scrollTop: 980, lastScrollTop: 980, distFromBottom: 40 })).toBe(true);
  });

  it('unlatches when the reader scrolls back down near the end', () => {
    expect(nextScrolledUp(true, { scrollTop: 990, lastScrollTop: 970, distFromBottom: 30 })).toBe(false);
  });

  it('unlatches at the very bottom', () => {
    expect(nextScrolledUp(true, { scrollTop: 1000, lastScrollTop: 1000, distFromBottom: 0 })).toBe(false);
  });

  it('does not latch when a shrink clamps scrollTop to the bottom', () => {
    expect(nextScrolledUp(false, { scrollTop: 900, lastScrollTop: 1000, distFromBottom: 0 })).toBe(false);
  });

  it('does not latch when a row grows below the viewport without an upward move', () => {
    expect(nextScrolledUp(false, { scrollTop: 1000, lastScrollTop: 1000, distFromBottom: 300 })).toBe(false);
  });
});
