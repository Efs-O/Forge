import type { QuestionSpec } from '../util/questionAnswers';
import type { RemoteContactButton } from './types';

const QUESTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const MAX_QUESTION_OPTIONS = 99;
const MAX_CALLBACK_DATA_BYTES = 64;

export type TelegramQuestionCallback =
  | { questionId: string; action: 'select'; choice: number }
  | { questionId: string; action: 'note' | 'next' | 'back' | 'skip' };

export function telegramQuestionButtons(
  questionId: string,
  spec: QuestionSpec,
  picks: readonly number[],
  step: number,
  stepCount: number,
): RemoteContactButton[][] {
  assertQuestionId(questionId);
  if (spec.options.length === 0 || spec.options.length > MAX_QUESTION_OPTIONS) {
    throw new Error('Forge Telegram question has an unsupported number of choices.');
  }
  if (stepCount < 1 || step < 0 || step >= stepCount) {
    throw new Error('Forge Telegram question step is invalid.');
  }
  const rows = spec.options.map((option, index) => {
    if (!option.label.trim()) throw new Error('Forge Telegram question choice is empty.');
    const selected = picks.includes(index);
    const mark = selected ? (spec.multiSelect ? '✓ ' : '● ') : '';
    return [
      {
        text: `${mark}${option.label}`,
        callbackData: encodeQuestionCallback(questionId, String(index + 1)),
      },
    ];
  });
  const controls: RemoteContactButton[] = [];
  if (step > 0) {
    controls.push({ text: '‹ Back', callbackData: encodeQuestionCallback(questionId, 'b') });
  }
  controls.push({ text: 'Note…', callbackData: encodeQuestionCallback(questionId, 'o') });
  controls.push({ text: 'Skip', callbackData: encodeQuestionCallback(questionId, 's') });
  controls.push({
    text: step + 1 === stepCount ? 'Send ✓' : 'Next ›',
    callbackData: encodeQuestionCallback(questionId, 'd'),
  });
  rows.push(controls);
  return rows;
}

export function parseTelegramQuestionCallback(data: string): TelegramQuestionCallback | undefined {
  const match = /^q:([A-Za-z0-9_-]{1,48}):(o|d|b|s|[0-9]{1,2})$/.exec(data);
  if (!match) return undefined;
  const questionId = match[1]!;
  switch (match[2]) {
    case 'o':
      return { questionId, action: 'note' };
    case 'd':
      return { questionId, action: 'next' };
    case 'b':
      return { questionId, action: 'back' };
    case 's':
      return { questionId, action: 'skip' };
    default: {
      const choice = Number(match[2]);
      return choice > 0 ? { questionId, action: 'select', choice } : undefined;
    }
  }
}

function encodeQuestionCallback(questionId: string, action: string): string {
  assertQuestionId(questionId);
  const data = `q:${questionId}:${action}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
    throw new Error('Forge Telegram question callback exceeds the Bot API limit.');
  }
  return data;
}

function assertQuestionId(questionId: string): void {
  if (!QUESTION_ID_PATTERN.test(questionId)) {
    throw new Error('Forge Telegram question identifier is invalid.');
  }
}
