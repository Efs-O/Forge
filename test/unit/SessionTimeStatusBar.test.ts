import { describe, expect, it } from 'vitest';
import { formatSessionDuration, formatSessionStatus } from '../../src/vscode/SessionTimeStatusBar';
import { formatTokens } from '../../src/util/formatTokens';

describe('SessionTimeStatusBar formatting', () => {
  it('formats durations as HH:MM:SS', () => {
    expect(formatSessionDuration(0)).toBe('00:00:00');
    expect(formatSessionDuration(3_661_000)).toBe('01:01:01');
  });

  it('formats compact token counts and preserves unavailable usage', () => {
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(2_000_000)).toBe('2M');
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

describe('SessionTimeStatusBar live and followed chats', () => {
  it('shows the running request as an estimate, marked with ~', () => {
    expect(
      formatSessionStatus({
        activeMs: 61_000,
        contextTokens: 19_000,
        outputTokens: 4_000,
        liveReasoningTokens: 1_250,
        liveAnswerTokens: 0,
      }),
    ).toBe(
      '$(timer) 00:01:01  $(layers) ctx 19k · session out 4k  $(sync~spin) think ~1.3k · answer ~0',
    );
  });

  it('names a followed chat that is not the one on screen, truncated', () => {
    expect(
      formatSessionStatus({
        activeMs: 0,
        following: 'claude: Implement the small library in docs',
      }),
    ).toBe(
      '$(eye) claude: Implement the sm…  $(timer) 00:00:00  $(layers) ctx — · session out —',
    );
  });
});
