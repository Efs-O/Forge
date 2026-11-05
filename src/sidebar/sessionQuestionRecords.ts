import type { ConversationPersisted, ConversationRuntime } from './sessionTypes';
import { questionAnswerRecord } from '../util/questionAnswers';
import type { QuestionAnswerRecord } from '../util/questionAnswers';

/** Copy display-only question records across the session persistence boundary. */
export function copyQuestionRecords(
  records:
    | NonNullable<ConversationRuntime['displayQuestionRecords']>
    | NonNullable<ConversationPersisted['display_question_records']>,
) {
  return records.map(({ toolCallId, record }) => ({
    toolCallId,
    record: questionAnswerRecord(record.specs, record.answer),
  }));
}

export function rememberQuestionRecord(
  conversation: ConversationRuntime,
  toolCallId: string,
  record: QuestionAnswerRecord,
): void {
  const records = conversation.displayQuestionRecords ?? [];
  conversation.displayQuestionRecords = [
    ...records.filter((existing) => existing.toolCallId !== toolCallId),
    { toolCallId, record: questionAnswerRecord(record.specs, record.answer) },
  ];
}
