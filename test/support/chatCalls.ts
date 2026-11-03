import { expect } from 'vitest';
import type { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import type { RemoteAgentProgress } from '../../src/remote/RemoteAgentProgress';

/**
 * Wraps a fake channel's chat calls so a test can say what happened before what.
 *
 * Telegram never moves a message, so most of the progress-display fixes are
 * claims about ORDER: the answer before the delete, the reopened working line
 * below the board and its receipt, the old Stop button off before the new one
 * goes on. A fake that keeps six separate arrays cannot answer which came
 * first, and a test that infers the order from a final state proves nothing.
 * This records every call as it runs, in the order the chat saw it.
 */
export function traceChatCalls(channel: FakeRemoteChannel): string[] {
  const calls: string[] = [];

  const send = channel.send.bind(channel);
  channel.send = async (chatId, text, options) => {
    calls.push(`send ${text}`);
    return send(chatId, text, options);
  };
  const remove = channel.deleteMessage.bind(channel);
  channel.deleteMessage = async (chatId, messageId) => {
    calls.push(`delete ${messageId}`);
    return remove(chatId, messageId);
  };
  const edit = channel.editMessage.bind(channel);
  channel.editMessage = async (chatId, messageId, text, options) => {
    calls.push(`edit ${messageId} ${text}`);
    return edit(chatId, messageId, text, options);
  };
  const openBubble = channel.sendProgress.bind(channel);
  channel.sendProgress = async (chatId, text, options) => {
    calls.push(`progress ${text}`);
    return openBubble(chatId, text, options);
  };
  const keyboard = channel.sendInlineKeyboard.bind(channel);
  channel.sendInlineKeyboard = async (chatId, text, buttons, options) => {
    calls.push(`keyboard ${firstLine(text)}`);
    return keyboard(chatId, text, buttons, options);
  };
  const clearKeyboard = channel.clearInlineKeyboard.bind(channel);
  channel.clearInlineKeyboard = async (chatId, messageId) => {
    calls.push(`clear ${messageId}`);
    return clearKeyboard(chatId, messageId);
  };
  const replaceKeyboard = channel.replaceInlineKeyboard.bind(channel);
  channel.replaceInlineKeyboard = async (chatId, messageId, buttons) => {
    calls.push(`replace ${messageId}`);
    return replaceKeyboard(chatId, messageId, buttons);
  };
  const photo = channel.sendPhoto.bind(channel);
  channel.sendPhoto = async (chatId, filePath, caption) => {
    calls.push(`photo ${caption}`);
    return photo(chatId, filePath, caption);
  };
  return calls;
}

/**
 * Wraps the working-line pair a bridge gets from the progress owner, so a test
 * can put `suspend` and `resume` in the same log as the chat calls around them.
 * The pair is what makes "the new working line landed below the receipt" a
 * measured claim instead of an assumption about which promise finished first.
 */
export function traceWorkingLine(progress: RemoteAgentProgress, calls: string[]): {
  suspendFooter: (conversationId: string) => void;
  resumeFooter: (conversationId: string) => void;
} {
  return {
    suspendFooter: (conversationId: string) => {
      calls.push(`hide ${conversationId}`);
      progress.suspendFooter(conversationId);
    },
    resumeFooter: (conversationId: string) => {
      calls.push(`show ${conversationId}`);
      progress.resumeFooter(conversationId);
    },
  };
}

/** The index of the first call that starts with `prefix`, or a failing message. */
export function callIndex(calls: string[], prefix: string): number {
  const index = calls.findIndex((call) => call.startsWith(prefix));
  expect(index, `no call starting with ${prefix} in: ${calls.join(' | ')}`).not.toBe(-1);
  return index;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}
