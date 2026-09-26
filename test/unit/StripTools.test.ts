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
});
