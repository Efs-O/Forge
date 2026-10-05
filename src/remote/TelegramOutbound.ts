import { z } from 'zod';
import { describeError } from '../util/describeError';
import { downloadTelegramAttachment, downloadTelegramAttachmentToFile } from './TelegramDownloads';
import { TelegramHelpMessages } from './TelegramHelpMessages';
import { sendTelegramPhoto } from './TelegramPhoto';
import { plainTelegramText, splitTelegramText } from './TelegramText';
import { sendTelegramVoice } from './TelegramVoice';
import { styleTelegramNotice } from './telegramNoticeStyle';
import type { TelegramChatQueue } from './telegramSendQueue';
import { telegramStopKeyboard as stopKeyboard } from './TelegramStopButton';
import type { ProgressMessageOptions, RemoteContactButton, RemoteInboundAttachment } from './types';

const TelegramSentMessageSchema = z.object({ message_id: z.number().int() });
const PROMPT_MESSAGE_LIMIT = 256;
const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;

/**
 * The one button a resolved approval leaves behind, greyed out by Telegram's
 * `DisabledButton` — an object with no fields, not a Boolean.
 */
function resolvedApprovalButton(approved: boolean): {
  text: string;
  disabled: Record<string, never>;
} {
  return { text: approved ? 'Approved ✓' : 'Denied ✗', disabled: {} };
}

type TelegramCall = (
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export class TelegramOutbound {
  private readonly promptMessages = new Map<string, number>();
  private readonly helpMessages: TelegramHelpMessages;

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
    options?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<string[]> {
    const notice = styleTelegramNotice(text);
    return notice
      ? this.sendText(chatId, notice, options, 'HTML')
      : this.sendText(chatId, plainTelegramText(text), options);
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
    options?: { correlationId?: string; signal?: AbortSignal },
    parseMode?: 'HTML',
  ): Promise<string[]> {
    const messageIds: string[] = [];
    const chunks = splitTelegramText(text);
    for (let index = 0; index < chunks.length; index++) {
      const correlationId = index === 0 ? options?.correlationId : undefined;
      const approveData = correlationId ? `a:${correlationId}` : undefined;
      const denyData = correlationId ? `d:${correlationId}` : undefined;
      if (
        (approveData &&
          Buffer.byteLength(approveData, 'utf8') > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) ||
        (denyData && Buffer.byteLength(denyData, 'utf8') > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES)
      ) {
        throw new Error('Forge Telegram approval identifier exceeds the Bot API limit.');
      }
      const sent = await this.call(
        'sendMessage',
        {
          chat_id: chatId,
          text: chunks[index],
          ...(parseMode ? { parse_mode: parseMode } : {}),
          ...(correlationId
            ? {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: 'Approve', callback_data: approveData },
                      { text: 'Deny', callback_data: denyData },
                    ],
                  ],
                },
              }
            : {}),
        },
        options?.signal,
      );
      if (correlationId) this.rememberPrompt(correlationId, sent);
      const parsed = TelegramSentMessageSchema.safeParse(sent);
      if (parsed.success) messageIds.push(String(parsed.data.message_id));
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
      { chat_id: chatId, text, ...stopKeyboard(options) },
      options?.signal,
    );
    const parsed = TelegramSentMessageSchema.safeParse(sent);
    return parsed.success ? String(parsed.data.message_id) : undefined;
  }

  async sendInlineKeyboard(
    chatId: string,
    text: string,
    buttons: readonly RemoteContactButton[][],
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<string | undefined> {
    const notice = options?.parseMode ? undefined : styleTelegramNotice(text);
    const chunks = splitTelegramText(notice ?? text);
    const keyboard = buttons.map((row) =>
      row.map((button) => {
        if (Buffer.byteLength(button.callbackData, 'utf8') > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
          throw new Error('Forge Telegram callback identifier exceeds the Bot API limit.');
        }
        return { text: button.text, callback_data: button.callbackData };
      }),
    );
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
          ...(index === 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
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
    await this.call(
      'editMessageReplyMarkup',
      { chat_id: chatId, message_id: Number(messageId), reply_markup: { inline_keyboard: [] } },
      options?.signal,
    );
  }

  /**
   * Replace a resolved prompt's Approve/Deny row with a single disabled button
   * naming the outcome, so the row stays visible instead of vanishing.
   *
   * `keyboardMessageIds` is what the approval bridge recorded from every send
   * that carried a keyboard for this correlation id — a republished gate leaves
   * more than one, and a keyboard Telegram never takes back is a button that
   * still looks pressable. The id remembered here for the correlation id is
   * folded in as well, so a bridge that lost track of one chunk still gets it
   * greyed out.
   *
   * The remembered correlation entry is dropped either way: this is the method
   * that clears it for a resolved prompt, and it must not blank the button it
   * just resolved.
   *
   * Throws when an edit failed, naming both the resolved-button failure and the
   * empty-keyboard fallback's failure when that failed too — a swallowed
   * failure here means the user keeps staring at a live Approve button with no
   * sign that anything went wrong.
   */
  async resolvePromptKeyboard(
    chatId: string,
    correlationId: string,
    keyboardMessageIds: readonly string[],
    approved: boolean,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const remembered = this.promptMessages.get(correlationId);
    this.promptMessages.delete(correlationId);
    const messageIds = [
      ...new Set([
        ...keyboardMessageIds,
        ...(remembered === undefined ? [] : [String(remembered)]),
      ]),
    ];
    const failures: string[] = [];
    for (const messageId of messageIds) {
      try {
        await this.call(
          'editMessageReplyMarkup',
          {
            chat_id: chatId,
            message_id: Number(messageId),
            reply_markup: { inline_keyboard: [[resolvedApprovalButton(approved)]] },
          },
          options?.signal,
        );
      } catch (err) {
        const disabledFailure = describeError(err);
        // Better a row that is gone than a row that still looks pressable.
        try {
          await this.clearInlineKeyboard(chatId, messageId, options);
          failures.push(
            `resolved approval button could not be set on message ${messageId} (keyboard cleared instead): ${disabledFailure}`,
          );
        } catch (clearErr) {
          failures.push(
            `resolved approval button could not be set on message ${messageId} and its keyboard could not be cleared either: ${disabledFailure}; ${describeError(clearErr)}`,
          );
        }
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    options?: ProgressMessageOptions,
  ): Promise<void> {
    await this.call(
      'editMessageText',
      { chat_id: chatId, message_id: Number(messageId), text, ...stopKeyboard(options) },
      options?.signal,
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

  async retractPrompt(chatId: string, correlationId: string, signal?: AbortSignal): Promise<void> {
    const messageId = this.promptMessages.get(correlationId);
    this.promptMessages.delete(correlationId);
    if (messageId === undefined) return;
    await this.call(
      'editMessageReplyMarkup',
      { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } },
      signal,
    ).catch(() => undefined);
  }

  private rememberPrompt(correlationId: string, sent: unknown): void {
    const parsed = TelegramSentMessageSchema.safeParse(sent);
    if (!parsed.success) return;
    if (this.promptMessages.size >= PROMPT_MESSAGE_LIMIT) {
      const oldest = this.promptMessages.keys().next();
      if (!oldest.done) this.promptMessages.delete(oldest.value);
    }
    this.promptMessages.set(correlationId, parsed.data.message_id);
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
