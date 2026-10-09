/** Within this many px of the bottom, a downward scroll resumes following. */
export const SCROLL_THRESHOLD = 80;

export interface ScrollSample {
  scrollTop: number;
  /** `scrollTop` at the previous scroll event. */
  lastScrollTop: number;
  /** `scrollHeight - scrollTop - clientHeight`. */
  distFromBottom: number;
}

/**
 * Whether the transcript should stop following new output, after one scroll
 * event. `scrolledUp` is the current value.
 *
 * Only an upward move is the reader leaving the bottom. Distance alone is not:
 * a smooth scroll still travelling, or a row that grew under the viewport (an
 * image decoding, an off-screen row replacing its 60px estimate), also leaves
 * the view >80px short, and latching there froze it mid-row.
 *
 * The upward check runs FIRST. A smooth wheel scroll moves a few pixels a
 * frame; testing the threshold first called those frames "at the bottom", and
 * the next streamed token re-pinned the view, so the reader could not scroll up
 * through a growing thinking bubble. A shrink that clamps `scrollTop` lands
 * exactly at the bottom (distance 0), so it never latches.
 */
export function nextScrolledUp(scrolledUp: boolean, sample: ScrollSample): boolean {
  const { scrollTop, lastScrollTop, distFromBottom } = sample;
  if (scrollTop < lastScrollTop - 1 && distFromBottom > 1) return true;
  if (distFromBottom <= 1) return false;
  // The reader scrolled back down to the end.
  if (distFromBottom <= SCROLL_THRESHOLD && scrollTop > lastScrollTop) return false;
  return scrolledUp;
}
