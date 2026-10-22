import type { RemoteInboundEvent } from './types';
import type { TelegramCallbackQuery } from './TelegramInboundMapping';
import { parseTelegramCommandCallback } from './TelegramCommandButtons';
import { parseTelegramJobCallback } from './TelegramJobButtons';
import { parseTelegramQueueCallback } from './TelegramQueueButtons';
import { parseTelegramAgentAskCallback } from './remoteAgentAsk';
import { parseTelegramSelectionCallback } from './TelegramSelectionPagination';
import { parseTelegramQuestionCallback } from './TelegramQuestionButtons';
import { parseTelegramHelpCallback } from './TelegramHelpButtons';
import { isTelegramStopCallback, isTelegramStopControlCallback } from './TelegramStopButton';
import { parseTelegramSendNowCallback } from './TelegramSendNowButton';

/** Routes each closed callback grammar to its corresponding inbound event. */
export function mapTelegramCallbackQuery(
  callback: TelegramCallbackQuery,
  mapChatType: (value: string) => RemoteInboundEvent['chatType'],
): RemoteInboundEvent | undefined {
  if (!callback.message || !callback.data) return undefined;
  const data = callback.data;
  const common = {
    channel: 'telegram' as const,
    providerMessageId: callback.id,
    senderId: String(callback.from.id),
    chatId: String(callback.message.chat.id),
    chatType: mapChatType(callback.message.chat.type),
    receivedAt: Date.now(),
    messageId: String(callback.message.message_id),
  };

  const command = parseTelegramCommandCallback(data);
  if (command) {
    return {
      ...common,
      kind: 'text',
      callbackMessageId: common.messageId,
      text: command.text,
    };
  }
  const sendNow = parseTelegramSendNowCallback(data);
  if (sendNow) return { ...common, kind: 'send_now_action', requestId: sendNow };
  const selection = parseTelegramSelectionCallback(data);
  if (selection) {
    return {
      ...common,
      kind: 'selection',
      selectionKind: selection.kind,
      selectionToken: selection.token,
      action: selection.action,
      ...(selection.page === undefined ? {} : { page: selection.page }),
      ...(selection.choice === undefined ? {} : { choice: selection.choice }),
      ...(selection.index === undefined ? {} : { index: selection.index }),
    };
  }
  const job = parseTelegramJobCallback(data);
  if (job) {
    return { ...common, kind: 'job_action', ...job, action: job.action ?? 'show' };
  }
  const question = parseTelegramQuestionCallback(data);
  if (question) {
    return {
      ...common,
      kind: 'question_action',
      questionId: question.questionId,
      action: question.action,
      ...(question.action === 'select' ? { choice: question.choice } : {}),
    };
  }
  const queue = parseTelegramQueueCallback(data);
  if (queue) {
    return {
      ...common,
      kind: 'queue_action',
      ...(queue.kind === 'all' ? { all: true } : { requestId: queue.requestId }),
    };
  }
  const help = parseTelegramHelpCallback(data);
  if (help) {
    return {
      ...common,
      kind: 'help_action',
      action: help.action,
      helpToken: help.action === 'section' ? help.sectionKey : help.action === 'menu' ? 'm' : 'x',
      ...(help.action === 'section' ? { sectionKey: help.sectionKey } : {}),
    };
  }
  const agentKind = parseTelegramAgentAskCallback(data);
  if (agentKind) return { ...common, kind: 'agent_ask_action', agentKind };
  if (isTelegramStopCallback(data)) {
    return {
      ...common,
      kind: 'stop_action',
      source: isTelegramStopControlCallback(data) ? 'control' : 'bubble',
      ...(isTelegramStopControlCallback(data) ? { control: true } : {}),
    };
  }
  const contact = /^c:([A-Za-z0-9_-]{16,48}):([sc])$/.exec(data);
  if (contact) {
    return {
      ...common,
      kind: 'contact_action',
      action: contact[2] === 's' ? 'send' : 'cancel',
      correlationId: contact[1]!,
    };
  }
  // Approval ids are generated as 24-byte base64url handles. Their fixed shape
  // keeps a:claude/codex/copilot in the ask-button family only.
  const approval = /^([ad]):([A-Za-z0-9_-]{24})$/.exec(data);
  if (approval) {
    return {
      ...common,
      kind: 'action',
      action: approval[1] === 'a' ? 'approve' : 'deny',
      correlationId: approval[2]!,
    };
  }
  return undefined;
}
