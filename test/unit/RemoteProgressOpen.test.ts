import { describe, expect, it, vi } from 'vitest';
import { openProgressBubble, removeProgressStopControl } from '../../src/remote/remoteProgressOpen';

const canDeliver = async (): Promise<boolean> => true;

describe('openProgressBubble', () => {
  it('sends the optional Stop control before status and leaves the button on it', async () => {
    const calls: string[] = [];
    const channel = {
      sendProgressStopControl: vi.fn(async () => {
        calls.push('control');
        return 'control-id';
      }),
      sendProgress: vi.fn(
        async (
          _chatId: string,
          _text: string,
          options?: { signal?: AbortSignal; stopButton?: boolean },
        ) => {
          calls.push('status');
          expect(options?.stopButton).toBe(false);
          return 'status-id';
        },
      ),
    };

    await expect(
      openProgressBubble(channel, 'chat', 'Forge: working…', new AbortController().signal, canDeliver),
    ).resolves.toEqual({
      kind: 'plain',
      messageId: 'status-id',
      stopButtonOnStatus: false,
      stopMessageId: 'control-id',
      stopMessageIsControl: true,
    });
    expect(calls).toEqual(['control', 'status']);
  });

  it('falls back to the inline button when creating the control row fails', async () => {
    const sendProgress = vi.fn(
      async (
        _chatId: string,
        _text: string,
        options?: { signal?: AbortSignal; stopButton?: boolean },
      ) => {
        expect(options?.stopButton).toBe(true);
        return 'status-id';
      },
    );
    const channel = {
      sendProgressStopControl: vi.fn(async () => {
        throw new Error('Telegram unavailable');
      }),
      sendProgress,
    };

    await expect(
      openProgressBubble(channel, 'chat', 'Forge: working…', new AbortController().signal, canDeliver),
    ).resolves.toMatchObject({
      kind: 'plain',
      messageId: 'status-id',
      stopButtonOnStatus: true,
      error: expect.stringContaining('Telegram unavailable'),
    });
  });

  it('reports a control send that returned no message id and keeps the status fallback', async () => {
    const channel = {
      sendProgressStopControl: vi.fn(async () => undefined),
      sendProgress: vi.fn(async () => 'status-id'),
    };

    await expect(
      openProgressBubble(channel, 'chat', 'Forge: working…', new AbortController().signal, canDeliver),
    ).resolves.toMatchObject({
      kind: 'plain',
      stopButtonOnStatus: true,
      error: expect.stringContaining('no message id was returned'),
    });
    expect(channel.sendProgress).toHaveBeenCalledWith('chat', 'Forge: working…', {
      signal: expect.any(AbortSignal),
      stopButton: true,
    });
  });

  it('keeps transports without the Telegram control capability unchanged', async () => {
    const sendProgress = vi.fn(async () => 'status-id');
    const channel = { sendProgress };

    await expect(
      openProgressBubble(channel, 'chat', 'Forge: working…', new AbortController().signal, canDeliver),
    ).resolves.toEqual({
      kind: 'plain',
      messageId: 'status-id',
      stopButtonOnStatus: true,
    });
    expect(sendProgress).toHaveBeenCalledWith('chat', 'Forge: working…', {
      signal: expect.any(AbortSignal),
      stopButton: true,
    });
  });

  it('removes a control row when the status message fails to open', async () => {
    const deleteMessage = vi.fn(async () => undefined);
    const channel = {
      sendProgressStopControl: vi.fn(async () => 'control-id'),
      sendProgress: vi.fn(async () => {
        throw new Error('status send failed');
      }),
      deleteMessage,
    };

    await expect(
      openProgressBubble(channel, 'chat', 'Forge: working…', new AbortController().signal, canDeliver),
    ).resolves.toMatchObject({
      kind: 'declined',
      error: expect.stringContaining('status send failed'),
    });
    expect(deleteMessage).toHaveBeenCalledWith('chat', 'control-id');
  });

  it('clears the keyboard when deleting the control row fails', async () => {
    const deleteMessage = vi.fn(async () => {
      throw new Error('delete denied');
    });
    const clearInlineKeyboard = vi.fn(async () => undefined);

    await expect(
      removeProgressStopControl({ deleteMessage, clearInlineKeyboard }, 'chat', 'control-id'),
    ).resolves.toBeUndefined();
    expect(clearInlineKeyboard).toHaveBeenCalledWith('chat', 'control-id');
  });

  it('does not send a prompt, Stop row, or status while the chat is locked', async () => {
    const sendProgress = vi.fn(async () => 'status-id');
    const sendProgressPrompt = vi.fn(async () => 'prompt-id');
    const sendProgressStopControl = vi.fn(async () => 'control-id');
    await expect(
      openProgressBubble(
        { sendProgress, sendProgressPrompt, sendProgressStopControl },
        'chat',
        'Forge: working…',
        new AbortController().signal,
        async () => false,
        'You (VS Code): hello',
      ),
    ).resolves.toEqual({ kind: 'declined', locked: true });
    expect(sendProgressPrompt).not.toHaveBeenCalled();
    expect(sendProgressStopControl).not.toHaveBeenCalled();
    expect(sendProgress).not.toHaveBeenCalled();
  });

  it('sends the mirrored prompt with its keyboard before the first progress status', async () => {
    const calls: string[] = [];
    const channel = {
      sendProgressPrompt: vi.fn(async () => {
        calls.push('prompt');
        return 'prompt-id';
      }),
      sendProgressStopControl: vi.fn(async () => {
        calls.push('control');
        return 'control-id';
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
    ).resolves.toMatchObject({
      kind: 'plain',
      messageId: 'status-id',
      stopButtonOnStatus: false,
      stopMessageId: 'prompt-id',
      stopMessageIsControl: false,
      promptSent: true,
    });
    expect(calls).toEqual(['prompt', 'status']);
    expect(channel.sendProgressPrompt).toHaveBeenCalledWith(
      'chat',
      'You (VS Code): hello',
      { signal: expect.any(AbortSignal) },
    );
  });
});
