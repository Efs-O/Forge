import { describe, expect, it } from 'vitest';
import { normalizeQuestions } from '../../src/util/questionAnswers';
import {
  parseTelegramQuestionCallback,
  telegramQuestionButtons,
} from '../../src/remote/TelegramQuestionButtons';
import { telegramUpdateToEvent } from '../../src/remote/TelegramInboundMapping';

const spec = (multiSelect = false) =>
  normalizeQuestions({
    prompt: 'Choose',
    questions: [{ prompt: 'Backend', multiSelect, options: ['A', 'B', 'C'] }],
  })[0]!;

describe('Telegram question buttons', () => {
  it('shows selected single and multi picks and step controls', () => {
    const single = telegramQuestionButtons('ask-123', spec(), [1], 0, 2);
    expect(single[1]![0]?.text).toBe('● B');
    expect(single.at(-1)?.map((button) => button.text)).toEqual([
      'Note…',
      'Skip',
      'Next ›',
    ]);
    const multi = telegramQuestionButtons('ask-123', spec(true), [0, 2], 1, 2);
    expect(multi[0]![0]?.text).toBe('✓ A');
    expect(multi[2]![0]?.text).toBe('✓ C');
    expect(multi.at(-1)?.map((button) => button.text)).toEqual([
      '‹ Back',
      'Note…',
      'Skip',
      'Send ✓',
    ]);
  });

  it('parses one-based option and control callbacks', () => {
    expect(parseTelegramQuestionCallback('q:ask-123:2')).toEqual({
      questionId: 'ask-123',
      action: 'select',
      choice: 2,
    });
    for (const [code, action] of [
      ['o', 'note'],
      ['d', 'next'],
      ['b', 'back'],
      ['s', 'skip'],
    ] as const) {
      expect(parseTelegramQuestionCallback(`q:ask-123:${code}`)).toEqual({
        questionId: 'ask-123',
        action,
      });
    }
    for (const data of ['q:ask-123:0', 'q:ask-123:100', 'q:ask-123:n', 'q:ask-123:free text']) {
      expect(parseTelegramQuestionCallback(data)).toBeUndefined();
    }
  });

  it('maps Telegram callbacks into question action events', () => {
    expect(
      telegramUpdateToEvent({
        update_id: 1,
        callback_query: {
          id: 'callback-1',
          data: 'q:ask-123:3',
          from: { id: 42 },
          message: { message_id: 7, chat: { id: 99, type: 'private' } },
        },
      }),
    ).toMatchObject({
      channel: 'telegram',
      kind: 'question_action',
      questionId: 'ask-123',
      action: 'select',
      choice: 3,
      chatId: '99',
      messageId: '7',
    });
  });

  it('keeps callbacks within 64 bytes for the longest supported id and choice', () => {
    const questionId = 'q'.repeat(48);
    const buttons = telegramQuestionButtons(
      questionId,
      { ...spec(), options: Array.from({ length: 99 }, (_, i) => ({ label: `Option ${i + 1}` })) },
      [],
      0,
      1,
    );
    const last = buttons[98]![0]!;
    expect(last.callbackData).toBe(`q:${questionId}:99`);
    expect(Buffer.byteLength(last.callbackData, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('rejects malformed ids, empty labels, and unsupported option counts', () => {
    expect(() => telegramQuestionButtons('bad id', spec(), [], 0, 1)).toThrow('identifier');
    expect(() =>
      telegramQuestionButtons('ask-123', { ...spec(), options: [{ label: ' ' }] }, [], 0, 1),
    ).toThrow('empty');
    expect(() =>
      telegramQuestionButtons(
        'ask-123',
        { ...spec(), options: Array.from({ length: 100 }, () => ({ label: 'A' })) },
        [],
        0,
        1,
      ),
    ).toThrow('unsupported number');
  });
});
