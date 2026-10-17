import { describe, expect, it, vi } from 'vitest';
import {
  parseActivityViewMode,
  parseThinkingDisplayMode,
  publishThinkingDisplay,
} from '../../src/sidebar/activityViewSetting';
import { hostMessageToAction } from '../../webview-ui/src/hostActions';

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

describe('thinking display setting parser', () => {
  it.each(['preview', 'open', 'collapsed'] as const)('accepts %s', (mode) => {
    expect(parseThinkingDisplayMode(mode)).toEqual({ success: true, mode });
  });

  it.each(['other', '', undefined, null, 3])('rejects %s with the received value', (value) => {
    expect(parseThinkingDisplayMode(value)).toEqual({
      success: false,
      received: value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value),
    });
  });

  it('publishes the setting through the typed bridge and maps it to webview state', () => {
    const post = vi.fn();
    expect(publishThinkingDisplay('collapsed', post)).toBeUndefined();
    expect(post).toHaveBeenCalledWith({ type: 'thinkingDisplay', mode: 'collapsed' });
    expect(hostMessageToAction({ type: 'thinkingDisplay', mode: 'open' })).toEqual({
      type: 'THINKING_DISPLAY',
      mode: 'open',
    });
  });
});
