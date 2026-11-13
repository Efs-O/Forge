import { describe, expect, it } from 'vitest';
import { ToolFailureTracker } from '../../src/tools/StripTools';

describe('ToolFailureTracker threshold', () => {
  it('does not strip before the threshold', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD - 1; i++) tracker.recordNativeParseFailure();
    expect(tracker.shouldStrip()).toBe(false);
  });

  it('strips at the threshold', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD; i++) tracker.recordNativeParseFailure();
    expect(tracker.shouldStrip()).toBe(true);
  });

  it('counts per conversation key', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD - 1; i++) {
      tracker.recordNativeParseFailure('a');
      tracker.recordNativeParseFailure('b');
    }
    expect(tracker.shouldStrip('a')).toBe(false);
    expect(tracker.shouldStrip('b')).toBe(false);
    tracker.recordNativeParseFailure('a');
    expect(tracker.shouldStrip('a')).toBe(true);
    expect(tracker.shouldStrip('b')).toBe(false);
  });

  it('reset clears the counter', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD; i++) tracker.recordNativeParseFailure();
    expect(tracker.shouldStrip()).toBe(true);
    tracker.reset();
    expect(tracker.shouldStrip()).toBe(false);
  });

  it('reset clears only that conversation', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD; i++) {
      tracker.recordNativeParseFailure('a');
      tracker.recordNativeParseFailure('b');
    }
    tracker.reset('a');
    expect(tracker.shouldStrip('a')).toBe(false);
    expect(tracker.shouldStrip('b')).toBe(true);
  });

  it('treats a success as the end of the streak', () => {
    // "Consecutive" has to mean consecutive: a model that recovered after
    // nine bad calls must not stay one call from losing its tools.
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD - 1; i++) tracker.recordNativeParseFailure('a');
    tracker.reset('a');
    for (let i = 0; i < ToolFailureTracker.THRESHOLD - 1; i++) tracker.recordNativeParseFailure('a');
    expect(tracker.shouldStrip('a')).toBe(false);
    tracker.recordNativeParseFailure('a');
    expect(tracker.shouldStrip('a')).toBe(true);
  });

  it('never strips on the strength of another conversation', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD; i++) tracker.recordNativeParseFailure('a');
    expect(tracker.shouldStrip('b')).toBe(false);
    expect(tracker.shouldStrip()).toBe(false);
  });
});

// Audit R1: the old tracker counted everything a tool complained about, so ten
// missing files in one chat looked like a model that cannot call tools, and the
// notice said "tools disabled" while text tool calls were working. The streak
// now answers one question only: can this server parse this model's calls?
describe('what the streak does not count', () => {
  it('reports the streak the user-facing notice quotes', () => {
    const tracker = new ToolFailureTracker();
    expect(tracker.streak('a')).toBe(0);
    tracker.recordNativeParseFailure('a');
    tracker.recordNativeParseFailure('a');
    expect(tracker.streak('a')).toBe(2);
    expect(tracker.streak('b')).toBe(0);
    tracker.reset('a');
    expect(tracker.streak('a')).toBe(0);
  });

  it('has exactly one thing that can raise it', () => {
    const raisers = Object.getOwnPropertyNames(ToolFailureTracker.prototype).filter(
      (name) => name !== 'constructor' && !['reset', 'shouldStrip', 'streak'].includes(name),
    );
    expect(raisers).toEqual(['recordNativeParseFailure']);
  });
});
