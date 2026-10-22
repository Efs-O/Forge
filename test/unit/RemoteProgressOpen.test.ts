import { describe, expect, it, vi } from 'vitest';
import { openProgressBubble, removeProgressStopControl } from '../../src/remote/remoteProgressOpen';

const canDeliver = async (): Promise<boolean> => true;

describe('openProgressBubble', () => {
  it('puts the inline Stop on the status message', async () => {
    // 0.17.69: the reply-keyboard key was too easy to hit while swiping, so
    // Stop rides inline on the status on every transport.
    const sendProgress = vi.fn(async () => 'status-id');
    const channel = { sendProgress };

    await expect(
      openProgressBubble(channel, 'chat', 'Forge: working…', new AbortController().signal, canDeliver),
    ).resolves.toEqual({ kind: 'plain', messageId: 'status-id' });
    expect(sendProgress).toHaveBeenCalledWith('chat', 'Forge: working…', {
      signal: expect.any(AbortSignal),
      stopButton: true,
    });
  });

  it('declines with the error when the status message fails to open', async () => {
    const channel = {
      sendProgress: vi.fn(async () => {
        throw new Error('status send failed');
      }),
    };

    await expect(
      openProgressBubble(channel, 'chat', 'Forge: working…', new AbortController().signal, canDeliver),
    ).resolves.toMatchObject({
      kind: 'declined',
      error: expect.stringContaining('status send failed'),
    });
  });

  it('clears the keyboard when deleting a legacy control row fails', async () => {
    const deleteMessage = vi.fn(async () => {
      throw new Error('delete denied');
    });
    const clearInlineKeyboard = vi.fn(async () => undefined);

    await expect(
      removeProgressStopControl({ deleteMessage, clearInlineKeyboard }, 'chat', 'control-id'),
    ).resolves.toBeUndefined();
    expect(clearInlineKeyboard).toHaveBeenCalledWith('chat', 'control-id');
  });

  it('does not send a prompt or status while the chat is locked', async () => {
    const sendProgress = vi.fn(async () => 'status-id');
    const sendProgressPrompt = vi.fn(async () => 'prompt-id');
    await expect(
      openProgressBubble(
        { sendProgress, sendProgressPrompt },
        'chat',
        'Forge: working…',
        new AbortController().signal,
        async () => false,
        'You (VS Code): hello',
      ),
    ).resolves.toEqual({ kind: 'declined', locked: true });
    expect(sendProgressPrompt).not.toHaveBeenCalled();
    expect(sendProgress).not.toHaveBeenCalled();
  });

  it('sends the mirrored prompt before the first progress status', async () => {
    const calls: string[] = [];
    const channel = {
      sendProgressPrompt: vi.fn(async () => {
        calls.push('prompt');
        return 'prompt-id';
      }),
      sendProgress: vi.fn(async () => {
        calls.push('status');
        return 'status-id';
      }),
    };
    await expect(
      openProgressBubble(
        channel,
        'chat',
        'Forge: working…',
        new AbortController().signal,
        canDeliver,
        'You (VS Code): hello',
      ),
    ).resolves.toEqual({ kind: 'plain', messageId: 'status-id', promptSent: true });
    expect(calls).toEqual(['prompt', 'status']);
    expect(channel.sendProgressPrompt).toHaveBeenCalledWith(
      'chat',
      'You (VS Code): hello',
      { signal: expect.any(AbortSignal) },
    );
  });
});
