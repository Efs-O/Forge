import type { RemoteContactButton } from './types';
import { getLogger } from '../util/logger';

const log = getLogger();

const CALLBACK_PATTERN = /^n:([0-9a-f-]{36})$/;

export function telegramSendNowButton(requestId: string): RemoteContactButton[][] {
  if (!/^[0-9a-f-]{36}$/.test(requestId)) {
    throw new Error('Forge Telegram queued request identifier is invalid.');
  }
  return [[{ text: '⚡ Send now', callbackData: `n:${requestId}` }]];
}

export function parseTelegramSendNowCallback(data: string): string | undefined {
  return CALLBACK_PATTERN.exec(data)?.[1];
}

type SendKeyboard = (
  chatId: string,
  text: string,
  buttons: RemoteContactButton[][],
  options?: { signal?: AbortSignal },
) => Promise<string | undefined>;
type RetireMessage = (chatId: string, messageId: string) => Promise<void>;

/** In-memory receipt ownership; durable request state remains authoritative. */
export class TelegramSendNowReceipts {
  private readonly receipts = new Map<string, { chatId: string; messageId: string }>();

  constructor(
    private readonly sendKeyboard: SendKeyboard,
    private readonly deleteMessage: RetireMessage,
    private readonly clearKeyboard: RetireMessage,
    private readonly onError?: (message: string) => void,
  ) {}

  async send(
    chatId: string,
    text: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const messageId = await this.sendKeyboard(
      chatId,
      text,
      telegramSendNowButton(requestId),
      signal ? { signal } : undefined,
    );
    if (messageId) this.receipts.set(requestId, { chatId, messageId });
    return messageId;
  }

  async retire(requestId: string): Promise<void> {
    const receipt = this.receipts.get(requestId);
    this.receipts.delete(requestId);
    if (!receipt) return;
    try {
      await this.deleteMessage(receipt.chatId, receipt.messageId);
    } catch (deleteError) {
      try {
        await this.clearKeyboard(receipt.chatId, receipt.messageId);
      } catch (clearError) {
        const detail = `${describe(deleteError)}; keyboard cleanup failed: ${describe(clearError)}`;
        this.report(`Forge Telegram Send now receipt cleanup failed: ${detail}`);
      }
    }
  }

  async retireTapped(requestId: string, chatId: string, messageId: string): Promise<void> {
    const receipt = this.receipts.get(requestId);
    if (receipt?.chatId === chatId && receipt.messageId === messageId) {
      this.receipts.delete(requestId);
    }
    const target =
      receipt?.chatId === chatId && receipt.messageId === messageId
        ? receipt
        : { chatId, messageId };
    try {
      await this.deleteMessage(target.chatId, target.messageId);
    } catch (deleteError) {
      try {
        await this.clearKeyboard(target.chatId, target.messageId);
      } catch (clearError) {
        this.report(
          `Forge Telegram Send now receipt cleanup failed: ${describe(deleteError)}; keyboard cleanup failed: ${describe(clearError)}`,
        );
      }
    }
  }

  private report(message: string): void {
    if (this.onError) this.onError(message);
    else log.error(message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
