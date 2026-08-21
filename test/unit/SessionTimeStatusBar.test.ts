import { describe, expect, it } from 'vitest';
import { formatSessionDuration, formatTokenCount } from '../../src/vscode/SessionTimeStatusBar';

describe('SessionTimeStatusBar formatting', () => {
  it('formats durations as HH:MM:SS', () => {
    expect(formatSessionDuration(0)).toBe('00:00:00');
    expect(formatSessionDuration(3_661_000)).toBe('01:01:01');
  });

  it('formats compact token counts and preserves unavailable usage', () => {
    expect(formatTokenCount(undefined)).toBe('—');
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(12_400)).toBe('12.4k');
    expect(formatTokenCount(2_000_000)).toBe('2M');
  });
});
