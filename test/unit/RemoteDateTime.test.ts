import { describe, expect, it } from 'vitest';
import { formatRemoteDateTime } from '../../src/remote/RemoteDateTime';

describe('formatRemoteDateTime', () => {
  it('uses an unambiguous European date and 24-hour local time', () => {
    const timestamp = new Date(2026, 7, 30, 19, 4).getTime();

    expect(formatRemoteDateTime(timestamp)).toBe('30/08/2026 19:04');
  });
});
