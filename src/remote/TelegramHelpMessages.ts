import { telegramCloseButton, telegramHelpMenuButton } from './TelegramHelpButtons';
import { renderRemoteHelpMenu, renderRemoteHelpSection } from './remoteHelpText';
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
  editInlineKeyboardMessage: (
    chatId: string,
    messageId: string,
    text: string,
    buttons: readonly RemoteContactButton[][],
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ) => Promise<void>;
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
    options?: {
      signal?: AbortSignal;
      parseMode?: 'HTML';
      buttons?: readonly RemoteContactButton[][];
    },
  ): Promise<void> {
    await this.transport.sendInlineKeyboard(
      chatId,
      text,
      options?.buttons ?? [[telegramCloseButton()]],
      options,
    );
  }

  async handleAction(event: HelpActionEvent): Promise<RemoteInboundDisposition> {
    if (event.action === 'close') {
      try {
        await this.transport.deleteMessage(event.chatId, event.messageId);
        return { kind: 'handled' };
      } catch (err) {
        this.reportFailure('close', err);
        return { kind: 'retry', reason: 'help message could not be closed' };
      }
    }
    if (event.action === 'menu') {
      const menu = renderRemoteHelpMenu();
      try {
        await this.transport.editInlineKeyboardMessage(
          event.chatId,
          event.messageId,
          menu.html,
          menu.buttons,
          { parseMode: 'HTML' },
        );
        return { kind: 'handled' };
      } catch (err) {
        this.reportFailure('menu edit', err);
        return { kind: 'retry', reason: 'help menu could not be updated' };
      }
    }
    const section = event.sectionKey ? renderRemoteHelpSection(event.sectionKey) : undefined;
    if (!section) return { kind: 'rejected', reason: 'help section is unavailable' };
    const sectionName = event.sectionKey;
    const buttons = [[telegramHelpMenuButton(), telegramCloseButton()]];
    try {
      await this.transport.editInlineKeyboardMessage(
        event.chatId,
        event.messageId,
        section[0]!,
        buttons,
        { parseMode: 'HTML' },
      );
      for (const extra of section.slice(1)) {
        await this.transport.sendInlineKeyboard(event.chatId, extra, buttons, {
          parseMode: 'HTML',
        });
      }
      return { kind: 'handled' };
    } catch (err) {
      this.reportFailure(`section ${sectionName ?? ''} edit`, err);
      try {
        for (const message of section) {
          await this.transport.sendInlineKeyboard(event.chatId, message, buttons, {
            parseMode: 'HTML',
          });
        }
        return { kind: 'handled' };
      } catch (sendError) {
        this.reportFailure(`section ${sectionName ?? ''} fallback`, sendError);
        return { kind: 'retry', reason: 'help section could not be shown' };
      }
    }
  }

  private reportFailure(operation: string, error: unknown): void {
    this.onError?.(
      `Forge Telegram help ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
