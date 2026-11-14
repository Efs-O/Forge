import { z } from 'zod';
import { downloadTelegramAttachment, downloadTelegramAttachmentToFile } from './TelegramDownloads';
import { TelegramHelpMessages } from './TelegramHelpMessages';
import { sendTelegramPhoto } from './TelegramPhoto';
import { sendTelegramAudio, sendTelegramDocument, sendTelegramVideo } from './TelegramMedia';
import { plainTelegramText, splitTelegramText } from './TelegramText';
import { BUBBLE_GAP_CHARS, withTelegramBubbleGap } from './telegramBubbleGap';
import { sendTelegramVoice } from './TelegramVoice';
import { styleTelegramNotice } from './telegramNoticeStyle';
import { inlineKeyboardMarkup } from './telegramInlineKeyboard';
import { TelegramPromptKeyboard } from './TelegramPromptKeyboard';
import type { TelegramChatQueue } from './telegramSendQueue';
import {
  telegramRemoveStopReplyKeyboard,
  telegramStopKeyboard as stopKeyboard,
  widenForStopButton,
} from './TelegramStopButton';
import type { ProgressMessageOptions, RemoteContactButton, RemoteInboundAttachment } from './types';

const TelegramSentMessageSchema = z.object({ message_id: z.number().int() });

type TelegramCall = (
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  options?: { retryRateLimit?: boolean },
) => Promise<unknown>;
type MediaSendArguments = [chatId: string, filePath: string, caption: string, signal?: AbortSignal];

/** Only the queue options a bubble call carries; the keyboard is separate. */
function callOptions(options?: ProgressMessageOptions): { retryRateLimit?: boolean } | undefined {
  return options?.retryRateLimit === undefined
    ? undefined
    : { retryRateLimit: options.retryRateLimit };
}

export class TelegramOutbound {
  private readonly helpMessages: TelegramHelpMessages;
  /** The approval keyboard a prompt bubble carries, and what becomes of it. */
  private readonly promptKeyboard = new TelegramPromptKeyboard(
    (chatId, messageId, markup, signal) => this.editReplyMarkup(chatId, messageId, markup, signal),
  );

  constructor(
    private readonly call: TelegramCall,
    private readonly fetchImpl: typeof fetch,
    private readonly token: string,
    private readonly sendQueue: TelegramChatQueue,
    onError?: (message: string) => void,
  ) {
    this.helpMessages = new TelegramHelpMessages(this, onError);
  }

  async send(
    chatId: string,
    text: string,
    options?: {
      correlationId?: string;
      approvalAllowChat?: boolean;
      approvalAlwaysInProject?: boolean;
      signal?: AbortSignal;
      parseMode?: 'HTML';
      speedLine?: string;
    },
  ): Promise<string[]> {
    const notice = options?.parseMode ? undefined : styleTelegramNotice(text);
    return notice
      ? this.sendText(chatId, notice, options, 'HTML')
      : this.sendText(
          chatId,
          options?.parseMode ? text : plainTelegramText(text),
          options,
          options?.parseMode,
        );
  }

  async sendHtml(
    chatId: string,
    html: string,
    options?: { signal?: AbortSignal },
  ): Promise<string[]> {
    return this.sendText(chatId, html, options, 'HTML');
  }

  private async sendText(
    chatId: string,
    text: string,
    options?: {
      correlationId?: string;
      approvalAllowChat?: boolean;
      approvalAlwaysInProject?: boolean;
      signal?: AbortSignal;
      speedLine?: string;
    },
    parseMode?: 'HTML',
  ): Promise<string[]> {
    const messageIds: string[] = [];
    // The split holds back room for the gap, and only the first part carries it:
    // a follow-on part is a continuation of the same answer, not a new bubble.
    const chunks = splitTelegramText(text, BUBBLE_GAP_CHARS);
    const line = options?.speedLine;
    if (line) {
      // One line, on the last part only, and never cut in half: re-splitting the
      // last chunk with the line appended keeps the line whole. When the answer
      // already filled its 4096 characters, the overflow and the line become one
      // further message, which is still the last part of the answer.
      const last = chunks.length - 1;
      chunks.splice(last, 1, ...splitTelegramText(`${chunks[last]}\n\n${line}`, BUBBLE_GAP_CHARS));
    }
    chunks[0] = withTelegramBubbleGap(chunks[0]);
    for (let index = 0; index < chunks.length; index++) {
      const correlationId = index === 0 ? options?.correlationId : undefined;
      // Only the first chunk of a send carries buttons, and their layout is
      // `telegramApprovalKeyboard`'s: two rows once the card offers a rule, so
      // the longest label is not the one Telegram truncates.
      const keyboard = correlationId
        ? this.promptKeyboard.keyboardFor(correlationId, {
            ...(options?.approvalAllowChat ? { allowChat: true } : {}),
            ...(options?.approvalAlwaysInProject ? { alwaysInProject: true } : {}),
          })
        : undefined;
      const sent = await this.call(
        'sendMessage',
        {
          chat_id: chatId,
          text: chunks[index],
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(keyboard ? { reply_markup: keyboard } : {}),
        },
        options?.signal,
      );
      const parsed = TelegramSentMessageSchema.safeParse(sent);
      if (parsed.success) {
        messageIds.push(String(parsed.data.message_id));
        // Only the first chunk carries a keyboard, so only that one is remembered.
        if (correlationId) this.promptKeyboard.remember(correlationId, parsed.data.message_id);
      }
    }
    return messageIds;
  }

  async sendProgress(
    chatId: string,
    text: string,
    options?: ProgressMessageOptions,
  ): Promise<string | undefined> {
    const sent = await this.call(
      'sendMessage',
      {
        chat_id: chatId,
        text: widenForStopButton(withTelegramBubbleGap(text), options),
        ...stopKeyboard(options),
      },
      options?.signal,
      callOptions(options),
    );
    const parsed = TelegramSentMessageSchema.safeParse(sent);
    return parsed.success ? String(parsed.data.message_id) : undefined;
  }

  async sendProgressPrompt(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined> {
    const sent = await this.call(
      'sendMessage',
      // Silent: it echoes the owner's own words, so it must not buzz the phone.
      { chat_id: chatId, text: withTelegramBubbleGap(text), disable_notification: true },
      options?.signal,
    );
    const parsed = TelegramSentMessageSchema.safeParse(sent);
    return parsed.success ? String(parsed.data.message_id) : undefined;
  }

  /** Removes the legacy 0.17.67 reply keyboard with a silent carrier, then deletes it. */
  async removeProgressStopKeyboard(chatId: string): Promise<void> {
    const sent = await this.call('sendMessage', {
      chat_id: chatId,
      text: '\u2063',
      disable_notification: true,
      reply_markup: telegramRemoveStopReplyKeyboard(),
    });
    const parsed = TelegramSentMessageSchema.safeParse(sent);
    if (!parsed.success) throw new Error('Telegram Stop keyboard removal returned no message id.');
    await this.deleteMessage(chatId, String(parsed.data.message_id));
  }

  async sendInlineKeyboard(
    chatId: string,
    text: string,
    buttons: readonly RemoteContactButton[][],
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<string | undefined> {
    const notice = options?.parseMode ? undefined : styleTelegramNotice(text);
    const chunks = splitTelegramText(notice ?? text, BUBBLE_GAP_CHARS);
    chunks[0] = withTelegramBubbleGap(chunks[0]);
    const replyMarkup = inlineKeyboardMarkup(buttons);
    let firstMessageId: string | undefined;
    for (let index = 0; index < chunks.length; index++) {
      const sent = await this.call(
        'sendMessage',
        {
          chat_id: chatId,
          text: chunks[index],
          ...(notice || options?.parseMode
            ? { parse_mode: notice ? 'HTML' : options?.parseMode }
            : {}),
          ...(index === 0 ? { reply_markup: replyMarkup } : {}),
        },
        options?.signal,
      );
      if (index === 0) {
        const parsed = TelegramSentMessageSchema.safeParse(sent);
        if (parsed.success) firstMessageId = String(parsed.data.message_id);
      }
    }
    return firstMessageId;
  }

  async editInlineKeyboardMessage(
    chatId: string,
    messageId: string,
    text: string,
    buttons: readonly RemoteContactButton[][],
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<void> {
    const replyMarkup = inlineKeyboardMarkup(buttons);
    await this.call(
      'editMessageText',
      {
        chat_id: chatId,
        message_id: Number(messageId),
        text: withTelegramBubbleGap(text),
        ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
        reply_markup: replyMarkup,
      },
      options?.signal,
    );
  }

  async sendForceReply(
    chatId: string,
    text: string,
    placeholder: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined> {
    const sent = await this.call(
      'sendMessage',
      {
        chat_id: chatId,
        text: withTelegramBubbleGap(text),
        reply_markup: {
          force_reply: true,
          input_field_placeholder: placeholder,
          selective: true,
        },
      },
      options?.signal,
    );
    const parsed = TelegramSentMessageSchema.safeParse(sent);
    return parsed.success ? String(parsed.data.message_id) : undefined;
  }

  sendHelp(
    ...args: Parameters<TelegramHelpMessages['send']>
  ): ReturnType<TelegramHelpMessages['send']> {
    return this.helpMessages.send(...args);
  }

  handleHelpAction(
    ...args: Parameters<TelegramHelpMessages['handleAction']>
  ): ReturnType<TelegramHelpMessages['handleAction']> {
    return this.helpMessages.handleAction(...args);
  }

  async answerCallbackQuery(
    callbackId: string,
    text?: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.call(
      'answerCallbackQuery',
      { callback_query_id: callbackId, ...(text ? { text } : {}) },
      options?.signal,
    );
  }

  async clearInlineKeyboard(
    chatId: string,
    messageId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.editReplyMarkup(chatId, messageId, { inline_keyboard: [] }, options?.signal);
  }

  async replaceInlineKeyboard(
    chatId: string,
    messageId: string,
    buttons: readonly RemoteContactButton[][],
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.editReplyMarkup(chatId, messageId, inlineKeyboardMarkup(buttons), options?.signal);
  }

  /**
   * Retire the buttons of a gate that was answered, timed out or cancelled.
   * The rules and the failure reporting live in `TelegramPromptKeyboard`, which
   * is also what remembers which message carries them.
   */
  resolvePromptKeyboard(
    ...args: Parameters<TelegramPromptKeyboard['resolve']>
  ): ReturnType<TelegramPromptKeyboard['resolve']> {
    return this.promptKeyboard.resolve(...args);
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    options?: ProgressMessageOptions,
  ): Promise<void> {
    await this.call(
      'editMessageText',
      {
        chat_id: chatId,
        message_id: Number(messageId),
        text: widenForStopButton(withTelegramBubbleGap(text), options),
        ...(options?.stopButton === false
          ? { reply_markup: { inline_keyboard: [] } }
          : stopKeyboard(options)),
      },
      options?.signal,
      callOptions(options),
    );
  }

  async deleteMessage(
    chatId: string,
    messageId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.call(
      'deleteMessage',
      { chat_id: chatId, message_id: Number(messageId) },
      options?.signal,
    );
  }

  retractPrompt(chatId: string, correlationId: string, signal?: AbortSignal): Promise<void> {
    return this.promptKeyboard.retract(chatId, correlationId, signal);
  }

  private async editReplyMarkup(
    chatId: string,
    messageId: string,
    replyMarkup: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    // postTelegram already treats Telegram's "message is not modified" as success.
    await this.call(
      'editMessageReplyMarkup',
      { chat_id: chatId, message_id: Number(messageId), reply_markup: replyMarkup },
      signal,
    );
  }

  async sendPhoto(
    chatId: string,
    filePath: string,
    caption: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await sendTelegramPhoto(
      this.fetchImpl,
      this.token,
      this.sendQueue,
      chatId,
      filePath,
      caption,
      signal,
    );
  }

  private sendMedia(
    kind: 'video' | 'audio' | 'document',
    ...args: MediaSendArguments
  ): Promise<void> {
    const send =
      kind === 'video'
        ? sendTelegramVideo
        : kind === 'audio'
          ? sendTelegramAudio
          : sendTelegramDocument;
    return send(this.fetchImpl, this.token, this.sendQueue, ...args);
  }

  sendVideo(...args: MediaSendArguments): Promise<void> {
    return this.sendMedia('video', ...args);
  }

  sendAudio(...args: MediaSendArguments): Promise<void> {
    return this.sendMedia('audio', ...args);
  }

  sendDocument(...args: MediaSendArguments): Promise<void> {
    return this.sendMedia('document', ...args);
  }

  async sendVoice(chatId: string, oggPath: string, signal?: AbortSignal): Promise<void> {
    await sendTelegramVoice(this.fetchImpl, this.token, this.sendQueue, chatId, oggPath, signal);
  }

  async downloadAttachment(attachment: RemoteInboundAttachment): Promise<RemoteInboundAttachment> {
    return downloadTelegramAttachment(attachment, {
      call: this.call,
      fetchImpl: this.fetchImpl,
      token: this.token,
    });
  }

  async downloadAttachmentToFile(
    providerFileId: string,
    targetPath: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: number; mediaType: string }> {
    return downloadTelegramAttachmentToFile(providerFileId, targetPath, signal, {
      call: this.call,
      fetchImpl: this.fetchImpl,
      token: this.token,
    });
  }
}
