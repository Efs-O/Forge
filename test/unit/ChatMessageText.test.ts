import { describe, expect, it } from 'vitest';
import {
  formatChatMessage,
  formatChatMirrorLine,
  parseChatMessage,
  quoteTitle,
  shortChatTitle,
} from '../../src/sidebar/chatMessageText';

describe('chat-to-chat message text', () => {
  it.each(['Claude', 'Codex', 'Copilot'])(
    'strips the %s title prefix',
    (agent) => {
      expect(shortChatTitle(`${agent}: Meeting room A`)).toBe('Meeting room A');
    },
  );

  it('cuts at a short-title sentence boundary before clipping', () => {
    expect(shortChatTitle('Meeting room A. This chat is about a longer subject')).toBe(
      'Meeting room A',
    );
    expect(shortChatTitle('A. This sentence boundary is too early')).toBe(
      'A. This sentence boundary is too early',
    );
  });

  it('clips long titles with an ellipsis and handles untitled or empty names', () => {
    const clipped = shortChatTitle('x'.repeat(50));
    expect(clipped).toBe(`${'x'.repeat(39)}…`);
    expect(clipped).toHaveLength(40);
    expect(shortChatTitle('Untitled chat')).toBe('new chat');
    expect(shortChatTitle('New chat')).toBe('new chat');
    expect(shortChatTitle('   ')).toBe('new chat');
    expect(shortChatTitle('Claude: ')).not.toBe('');
    expect(shortChatTitle('a title', 0)).not.toBe('');
  });

  it('quotes titles with plain quotation marks', () => {
    expect(quoteTitle('Bug "hunt"')).toBe('"Bug \'hunt\'"');
  });

  it.each([
    '',
    'A message with a newline.\nThe second line includes 📨 as content.',
    'Body contains the trailer text: (Reply with message_chat to "id" if you need to; no need to just acknowledge.)',
    'Ends with the trailer itself.\n\n(Reply with message_chat to "id" if you need to; no need to just acknowledge.)',
    '📨 Message from a user by hand, followed by body text.',
  ])('round trips arbitrary body text: %s', (body) => {
    const formatted = formatChatMessage('Claude: Meeting room A. Details follow', 'id', body);
    expect(formatted).toBe(
      `📨 Message from Meeting room A (id id):\n${body}\n\n(Reply with message_chat to "id" if you need to; no need to just acknowledge.)`,
    );
    expect(parseChatMessage(formatted)).toEqual({
      fromTitle: 'Meeting room A',
      fromId: 'id',
      body,
    });
  });

  it('does not recognize a typed header without its exact trailer', () => {
    expect(parseChatMessage('📨 Message from Sender (id sender):\nhello')).toBeUndefined();
    expect(parseChatMessage('📨 Message from a user\nhello')).toBeUndefined();
    expect(
      parseChatMessage(
        '📨 Message from Sender (id sender):\nhello\n\n(Reply with message_chat to "other" if you need to; no need to just acknowledge.)',
      ),
    ).toBeUndefined();
    expect(
      parseChatMessage(
        '📨 Message from Sender (id sender):\nhello\n\n(Reply with message_chat to "sender" if you need to; no need to just acknowledge.)\nextra',
      ),
    ).toBeUndefined();
  });

  it('parses the persisted 0.17.73-74 form', () => {
    const legacy =
      '[message_chat from #4 "Claude: Meeting room A. More title text" (id 08fb1bcd)]\n' +
      'Please review this.\n\n' +
      '(Answer with message_chat to "08fb1bcd" only if a reply is needed; do not reply just to acknowledge.)';
    expect(parseChatMessage(legacy)).toEqual({
      fromTitle: 'Meeting room A',
      fromId: '08fb1bcd',
      body: 'Please review this.',
    });
  });

  it.each([
    ['tell', 'busy · reads it mid-turn'],
    ['turn', 'idle · started a turn'],
    ['unconfirmed', 'not confirmed yet'],
    ['steer', 'steering · interrupts its turn if it is generating'],
  ] as const)('formats %s status for both mirror directions', (status, statusText) => {
    expect(formatChatMirrorLine('in', 'Codex: Meeting room A', status, 'hello')).toBe(
      `📨 Meeting room A → this chat  (${statusText})\nhello`,
    );
    expect(formatChatMirrorLine('out', 'Copilot: Meeting room A', status, 'hello')).toBe(
      `📤 this chat → Meeting room A  (${statusText})\nhello`,
    );
  });

  it('omits status when the inbound mirror line has no delivery state', () => {
    expect(formatChatMirrorLine('in', 'Meeting room A', undefined, 'hello')).toBe(
      '📨 Meeting room A → this chat\nhello',
    );
  });
});
