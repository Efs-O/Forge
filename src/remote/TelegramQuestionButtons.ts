import type { RemoteContactButton } from './types';

const QUESTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const MAX_QUESTION_OPTIONS = 100;
const MAX_BUTTON_TEXT_BYTES = 64;
const MAX_CALLBACK_DATA_BYTES = 64;

export interface TelegramQuestionCallback {
  questionId: string;
  action: 'select' | 'other';
  choice?: number;
}

/** Builds a bounded, question-specific keyboard without putting answer text in callbacks. */
export function telegramQuestionButtons(
  questionId: string,
  options: readonly string[],
): RemoteContactButton[][] {
  assertQuestionId(questionId);
  if (options.length === 0 || options.length > MAX_QUESTION_OPTIONS) {
    throw new Error('Forge Telegram question has an unsupported number of choices.');
  }
  const rows = options.map((label, choice) => {
    if (!label.trim() || Buffer.byteLength(label, 'utf8') > MAX_BUTTON_TEXT_BYTES) {
      throw new Error('Forge Telegram question choice exceeds the button text limit.');
    }
    return [{ text: label, callbackData: encodeQuestionCallback(questionId, choice) }];
  });
  rows.push([{ text: 'Other…', callbackData: encodeQuestionCallback(questionId, 'o') }]);
  return rows;
}

export function parseTelegramQuestionCallback(data: string): TelegramQuestionCallback | undefined {
  const match = /^q:([A-Za-z0-9_-]{1,48}):(o|[0-9]{1,2})$/.exec(data);
  if (!match) return undefined;
  if (match[2] === 'o') return { questionId: match[1]!, action: 'other' };
  return {
    questionId: match[1]!,
    action: 'select',
    choice: Number(match[2]),
  };
}

function encodeQuestionCallback(questionId: string, choice: number | 'o'): string {
  assertQuestionId(questionId);
  const data = `q:${questionId}:${choice}`;
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
