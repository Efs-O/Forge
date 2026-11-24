import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
}));

import type { HostToWebview } from '../../src/sidebar/messageBridge';
import { ToolApprovalService, type ToolApprovalSink } from '../../src/sidebar/ToolApprovalService';

const offer = { keys: ['cross_chat'], label: 'messages to other chats' };

describe('Always in this project approval button', () => {
  afterEach(() => vi.useRealTimers());

  it('writes only the offered project rule after the owner clicks the button', async () => {
    const posted: HostToWebview[] = [];
    const allowChat = vi.fn(() => []);
    const writeAlways = vi.fn(() => ({ kind: 'written' as const }));
    const resolved = vi.fn();
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
      undefined,
      undefined,
      undefined,
      allowChat,
      writeAlways,
    );
    service.addSink({
      requested: () => undefined,
      resolved: (event) => resolved(event),
    } satisfies ToolApprovalSink);
    const pending = service.request('message_chat', 'Send a note', false, 'chat-1', undefined, {
      allowForChat: offer,
      alwaysInProject: offer,
    });
    const card = posted.find((message) => message.type === 'confirmRequest');
    if (card?.type !== 'confirmRequest') throw new Error('confirmation was not posted');
    expect(card.alwaysInProject).toEqual(offer);

    service.resolve(card.id, 'alwaysProject', 'webview');
    await expect(pending).resolves.toBe('approved');
    expect(writeAlways).toHaveBeenCalledWith(['cross_chat']);
    expect(allowChat).not.toHaveBeenCalled();
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'alwaysProject',
        approvalNotice: 'Always in this project saved (messages to other chats).',
      }),
    );
  });

  it('keeps a locked policy rule for this chat and tells the owner to unlock policy.yaml', async () => {
    const posted: HostToWebview[] = [];
    const allowChat = vi.fn(() => []);
    const writeAlways = vi.fn(() => ({
      kind: 'locked' as const,
      message: 'Unlock policy.yaml to save this project rule.',
    }));
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
      undefined,
      undefined,
      undefined,
      allowChat,
      writeAlways,
    );
    const pending = service.request('message_chat', 'Send a note', false, 'chat-1', undefined, {
      allowForChat: offer,
      alwaysInProject: offer,
    });
    const card = posted.find((message) => message.type === 'confirmRequest');
    if (card?.type !== 'confirmRequest') throw new Error('confirmation was not posted');

    service.resolve(card.id, 'alwaysProject', 'webview');
    await expect(pending).resolves.toBe('approved');
    expect(allowChat).toHaveBeenCalledWith('chat-1', ['cross_chat']);
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'notice',
        conversationId: 'chat-1',
        message: expect.stringContaining('Unlock policy.yaml'),
      }),
    );
    expect(posted.find((message) => message.type === 'notice')).toMatchObject({
      message: expect.stringContaining('kept for this chat only'),
    });
  });

  it('does not hide a different policy write failure behind a chat-only save', async () => {
    const posted: HostToWebview[] = [];
    const allowChat = vi.fn(() => []);
    const service = new ToolApprovalService(
      (message) => posted.push(message),
      () => ({}) as never,
      undefined,
      undefined,
      undefined,
      allowChat,
      () => ({ kind: 'failed', message: 'disk full' }),
    );
    const pending = service.request('message_chat', 'Send a note', false, 'chat-1', undefined, {
      allowForChat: offer,
      alwaysInProject: offer,
    });
    const card = posted.find((message) => message.type === 'confirmRequest');
    if (card?.type !== 'confirmRequest') throw new Error('confirmation was not posted');

    service.resolve(card.id, 'alwaysProject', 'webview');
    await expect(pending).resolves.toBe('approved');
    expect(allowChat).not.toHaveBeenCalled();
    expect(posted.find((message) => message.type === 'notice')).toMatchObject({
      message: expect.stringContaining('the project rule was not stored'),
    });
  });
});
