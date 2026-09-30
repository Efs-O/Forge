import { describe, expect, it } from 'vitest';
import { ToolFailureTracker } from '../../src/tools/StripTools';

describe('ToolFailureTracker threshold', () => {
  it('does not strip before the threshold', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD - 1; i++) tracker.record();
    expect(tracker.shouldStrip()).toBe(false);
  });

  it('strips at the threshold', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD; i++) tracker.record();
    expect(tracker.shouldStrip()).toBe(true);
  });

  it('counts per conversation key', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD - 1; i++) {
      tracker.record('a');
      tracker.record('b');
    }
    expect(tracker.shouldStrip('a')).toBe(false);
    expect(tracker.shouldStrip('b')).toBe(false);
    tracker.record('a');
    expect(tracker.shouldStrip('a')).toBe(true);
    expect(tracker.shouldStrip('b')).toBe(false);
  });

  it('reset clears the counter', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD; i++) tracker.record();
    expect(tracker.shouldStrip()).toBe(true);
    tracker.reset();
    expect(tracker.shouldStrip()).toBe(false);
  });

  it('reset clears only that conversation', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD; i++) {
      tracker.record('a');
      tracker.record('b');
    }
    tracker.reset('a');
    expect(tracker.shouldStrip('a')).toBe(false);
    expect(tracker.shouldStrip('b')).toBe(true);
  });

  it('treats a success as the end of the streak', () => {
    // "Consecutive" has to mean consecutive: a model that recovered after
    // nine bad calls must not stay one call from losing its tools.
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD - 1; i++) tracker.record('a');
    tracker.reset('a');
    for (let i = 0; i < ToolFailureTracker.THRESHOLD - 1; i++) tracker.record('a');
    expect(tracker.shouldStrip('a')).toBe(false);
    tracker.record('a');
    expect(tracker.shouldStrip('a')).toBe(true);
  });

  it('never strips on the strength of another conversation', () => {
    const tracker = new ToolFailureTracker();
    for (let i = 0; i < ToolFailureTracker.THRESHOLD; i++) tracker.record('a');
    expect(tracker.shouldStrip('b')).toBe(false);
    expect(tracker.shouldStrip()).toBe(false);
  });
});
