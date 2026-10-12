export interface ScrollSample {
  /** `scrollHeight - scrollTop - clientHeight`. */
  distFromBottom: number;
}

export type ReaderScrollIntent =
  | { kind: 'wheel' | 'touch'; delta: number }
  | { kind: 'scrollbar'; delta: number }
  | { kind: 'keyboard'; key: string; shiftKey?: boolean };

/** True only for a reader action that moves toward earlier transcript content. */
export function isScrollUpIntent(intent: ReaderScrollIntent): boolean {
  if (intent.kind === 'keyboard') {
    return (
      intent.key === 'ArrowUp' ||
      intent.key === 'PageUp' ||
      intent.key === 'Home' ||
      (intent.key === ' ' && intent.shiftKey === true)
    );
  }
  return intent.delta < 0;
}

/**
 * Update follow state from geometry only. Upward intent is classified from
 * wheel, touch, keyboard, or scrollbar input; scroll events themselves may be
 * caused by layout correction or Forge's own pinning and must not latch.
 */
export function nextScrolledUp(scrolledUp: boolean, sample: ScrollSample): boolean {
  if (sample.distFromBottom <= 1) return false;
  return scrolledUp;
}
