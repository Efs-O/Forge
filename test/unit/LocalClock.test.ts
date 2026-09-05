import { describe, expect, it } from 'vitest';
import { localDate, localTimeOfDay } from '../../src/util/localClock';

describe('localClock', () => {
  it('renders a zero-padded local date', () => {
    expect(localDate(new Date(2026, 8, 5, 16, 27))).toBe('2026-09-05');
  });

  // The system prompt is the KV cache prefix — a time in it re-processes the
  // whole prompt every turn.
  it('keeps the date free of any time of day', () => {
    expect(localDate()).not.toMatch(/:/u);
  });

  it('renders the wall clock as zero-padded 24-hour HH:MM', () => {
    expect(localTimeOfDay(new Date(2026, 8, 5, 16, 27, 45))).toBe('16:27');
    expect(localTimeOfDay(new Date(2026, 8, 5, 9, 4))).toBe('09:04');
    expect(localTimeOfDay(new Date(2026, 8, 5, 0, 0))).toBe('00:00');
  });
});
