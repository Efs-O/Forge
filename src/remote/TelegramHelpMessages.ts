import { telegramHelpButton } from './TelegramHelpButtons';
import type { RemoteContactButton, RemoteInboundDisposition, RemoteInboundEvent } from './types';

type HelpActionEvent = Extract<RemoteInboundEvent, { kind: 'help_action' }>;
type SendInlineKeyboard = (
  chatId: string,
  text: string,
  buttons: readonly RemoteContactButton[][],
  options?: { signal?: AbortSignal; parseMode?: 'HTML' },
) => Promise<string | undefined>;

interface TelegramHelpTransport {
  sendInlineKeyboard: SendInlineKeyboard;
  deleteMessage: (chatId: string, messageId: string) => Promise<void>;
}

/** Telegram help messages whose lifetime is controlled by the user. */
export class TelegramHelpMessages {
  constructor(
    private readonly transport: TelegramHelpTransport,
    private readonly onError?: (message: string) => void,
  ) {}

  async send(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<void> {
    await this.transport.sendInlineKeyboard(chatId, text, [[telegramHelpButton()]], options);
  }

  async handleAction(event: HelpActionEvent): Promise<RemoteInboundDisposition> {
    try {
      await this.transport.deleteMessage(event.chatId, event.messageId);
      return { kind: 'handled' };
    } catch (err) {
      this.onError?.(
        `Forge Telegram help close failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: 'retry', reason: 'help message could not be closed' };
    }
  }
}
