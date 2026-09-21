import { describe, expect, it } from 'vitest';
import {
  parseTelegramQuestionCallback,
  telegramQuestionButtons,
} from '../../src/remote/TelegramQuestionButtons';
import { telegramUpdateToEvent } from '../../src/remote/TelegramInboundMapping';

describe('Telegram question buttons', () => {
  it('builds bounded callbacks for each option and Other', () => {
    const buttons = telegramQuestionButtons('ask-123', ['A', 'B']).flat();
    expect(buttons.map((button) => button.callbackData)).toEqual([
      'q:ask-123:0',
      'q:ask-123:1',
      'q:ask-123:o',
    ]);
    expect(buttons.every((button) => Buffer.byteLength(button.callbackData, 'utf8') <= 64)).toBe(
      true,
    );
    expect(parseTelegramQuestionCallback('q:ask-123:1')).toEqual({
      questionId: 'ask-123',
      action: 'select',
      choice: 1,
    });
    expect(parseTelegramQuestionCallback('q:ask-123:o')).toEqual({
      questionId: 'ask-123',
      action: 'other',
    });
  });

  it('maps a Telegram callback into a question action event', () => {
    expect(
      telegramUpdateToEvent({
        update_id: 1,
        callback_query: {
          id: 'callback-1',
          data: 'q:ask-123:1',
          from: { id: 42 },
          message: { message_id: 7, chat: { id: 99, type: 'private' } },
        },
      }),
    ).toMatchObject({
      channel: 'telegram',
      kind: 'question_action',
      questionId: 'ask-123',
      action: 'select',
      choice: 1,
      chatId: '99',
      messageId: '7',
    });
  });

  it('rejects unsafe button labels and malformed callbacks', () => {
    expect(() => telegramQuestionButtons('ask-123', [' '.repeat(65)])).toThrow(
      'button text limit',
    );
    expect(parseTelegramQuestionCallback('q:ask-123:100')).toBeUndefined();
    expect(parseTelegramQuestionCallback('q:ask-123:free text')).toBeUndefined();
  });
});
