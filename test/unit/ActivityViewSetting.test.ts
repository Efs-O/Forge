import { describe, expect, it } from 'vitest';
import { parseActivityViewMode } from '../../src/sidebar/activityViewSetting';

describe('activity view setting parser', () => {
  it.each(['grouped', 'compact', 'full'] as const)('accepts %s', (mode) => {
    expect(parseActivityViewMode(mode)).toEqual({ success: true, mode });
  });

  it.each(['other', '', undefined, null, 3])('rejects %s with the received value', (value) => {
    expect(parseActivityViewMode(value)).toEqual({
      success: false,
      received: value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value),
    });
  });
});
