import { describe, expect, it } from 'vitest';
import {
  formatSessionDuration,
  formatSessionStatus,
  formatTokenCount,
} from '../../src/vscode/SessionTimeStatusBar';

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

  it('separates current context from cumulative session output', () => {
    expect(
      formatSessionStatus({
        activeMs: 3_661_000,
        contextTokens: 28_000,
        outputTokens: 3_100,
      }),
    ).toBe('$(timer) 01:01:01  $(layers) ctx 28k · session out 3.1k');
  });
});
