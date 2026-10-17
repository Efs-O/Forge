import { describe, expect, it } from 'vitest';
import { formatMessageTimestamp } from '../../webview-ui/src/messageTimestamp';

describe('formatMessageTimestamp', () => {
  it('shows local HH:MM for today', () => {
    const now = new Date(2026, 9, 17, 18, 30);
    const createdAt = new Date(2026, 9, 17, 9, 5).getTime();
    expect(formatMessageTimestamp(createdAt, now)).toBe('09:05');
  });

  it('adds the local date for older messages', () => {
    const now = new Date(2026, 9, 17, 8, 0);
    const createdAt = new Date(2026, 9, 16, 23, 45).getTime();
    const date = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(createdAt));
    expect(formatMessageTimestamp(createdAt, now)).toBe(`${date} · 23:45`);
  });

  it('omits absent and invalid timestamps', () => {
    expect(formatMessageTimestamp(undefined)).toBeUndefined();
    expect(formatMessageTimestamp(Number.NaN)).toBeUndefined();
    expect(formatMessageTimestamp(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
