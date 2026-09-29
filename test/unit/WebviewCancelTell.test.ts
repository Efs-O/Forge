import { describe, expect, it, vi } from 'vitest';
import {
  routeWebviewMessage,
  type WebviewActions,
} from '../../src/sidebar/webviewMessageRouter';

function rig(cancelled: boolean) {
  const post = vi.fn();
  const cancelTell = vi.fn(() => cancelled);
  // Only the two actions a cancelTell touches; any other call is a test failure.
  const actions = { post, cancelTell } as unknown as WebviewActions;
  routeWebviewMessage(actions, { type: 'cancelTell', conversationId: 'c1', tellId: 'chip-1' });
  return { post, cancelTell };
}

describe('cancelTell from the sidebar', () => {
  it('withdraws the tell quietly while the turn has not read it', () => {
    const { post, cancelTell } = rig(true);
    expect(cancelTell).toHaveBeenCalledWith('c1', 'chip-1');
    expect(post).not.toHaveBeenCalled();
  });

  it('says so when the running turn had already read it', () => {
    const { post } = rig(false);
    expect(post).toHaveBeenCalledWith({
      type: 'error',
      message: 'Forge: that message had already reached the running turn.',
    });
  });
});
