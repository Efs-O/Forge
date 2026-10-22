import type {
  RemoteChannel,
  RemoteContactButton,
  RemoteInboundDisposition,
  RemoteInboundEvent,
  RemoteSelectionChoice,
  RemoteSelectionControls,
} from './types';
import { TelegramHelpMessages } from './TelegramHelpMessages';

export class FakeRemoteChannel implements RemoteChannel {
  readonly name: RemoteChannel['name'];
  readonly sent: Array<{
    chatId: string;
    text: string;
    correlationId?: string;
    parseMode?: 'HTML';
  }> = [];
  readonly retracted: Array<{ chatId: string; correlationId: string }> = [];
  /** Records resolved-approval keyboard edits so tests can assert the outcome button. */
  readonly resolvedKeyboards: Array<{
    chatId: string;
    correlationId: string;
    keyboardMessageIds: readonly string[];
    approved: boolean;
  }> = [];
  /** When set, the resolved-keyboard edit fails with this message. */
  resolveKeyboardError?: string;
  /** When set, inline report/help edits fail to exercise their send fallback. */
  inlineEditError?: string;
  /**
   * When set, `send` throws this message. Opt-in because the failure it models
   * is the interesting one: a command whose real work is already durable must
   * absorb a failed acknowledgement instead of throwing into the retry path.
   */
  sendError?: string;
  /** Records command auto-cleanup deletes so tests can assert they fired. */
  readonly deleted: Array<{ chatId: string; messageId: string }> = [];
  readonly photos: Array<{ chatId: string; filePath: string; caption: string }> = [];
  readonly progress: Array<{ chatId: string; text: string }> = [];
  /** Message ids currently showing the turn's ⏹ Stop button. */
  readonly stopButtons = new Set<string>();
  readonly inlineKeyboards: Array<{
    chatId: string;
    text: string;
    buttons: readonly RemoteContactButton[][];
    parseMode?: 'HTML';
  }> = [];
  readonly inlineKeyboardReplacements: Array<{
    chatId: string;
    messageId: string;
    buttons: readonly RemoteContactButton[][];
  }> = [];
  readonly callbackAnswers: Array<{ callbackId: string; text?: string }> = [];
  readonly clearedKeyboards: Array<{ chatId: string; messageId: string }> = [];
  readonly edits: Array<{ chatId: string; messageId: string; text: string }> = [];
  readonly inlineEdits: Array<{
    chatId: string;
    messageId: string;
    text: string;
    buttons: readonly RemoteContactButton[][];
    parseMode?: 'HTML';
  }> = [];
  readonly forceReplies: Array<{ chatId: string; text: string; placeholder: string }> = [];
  readonly selectionPageSends: Array<{
    chatId: string;
    text: string;
    controls: RemoteSelectionControls;
    parseMode?: 'HTML';
  }> = [];
  readonly selectionEdits: Array<{
    chatId: string;
    messageId: string;
    text: string;
    controls: RemoteSelectionControls;
    parseMode?: 'HTML';
  }> = [];
  readonly selectionChoiceSends: Array<{
    chatId: string;
    text: string;
    choices: readonly RemoteSelectionChoice[];
    controls: RemoteSelectionControls;
  }> = [];
  constructor(name: RemoteChannel['name'] = 'fake') {
    this.name = name;
  }
  /**
   * Opt-in, because its presence is what the pager reads as "this transport
   * parses HTML". Declaring it unconditionally would make every existing test's
   * selection page rich, which is the opposite of what a fake is for.
   */
  parseMode?: 'HTML';
  sendHtml?: (chatId: string, html: string) => Promise<void>;
  declareHtmlSupport(): void {
    this.parseMode = 'HTML';
    this.sendHtml = async (chatId: string, html: string): Promise<void> => {
      this.sent.push({ chatId, text: html });
    };
  }
  readonly selectionCloses: Array<{ chatId: string; messageId: string }> = [];
  readonly selectionPages = {
    send: async (
      chatId: string,
      text: string,
      controls: RemoteSelectionControls,
      options?: { parseMode?: 'HTML' },
    ): Promise<void> => {
      this.selectionPageSends.push({ chatId, text, controls, ...pageMode(options) });
    },
    edit: async (
      chatId: string,
      messageId: string,
      text: string,
      controls: RemoteSelectionControls,
      options?: { parseMode?: 'HTML' },
    ): Promise<void> => {
      this.selectionEdits.push({ chatId, messageId, text, controls, ...pageMode(options) });
    },
    sendChoices: async (
      chatId: string,
      text: string,
      choices: readonly RemoteSelectionChoice[],
      controls: RemoteSelectionControls,
    ): Promise<void> => {
      this.selectionChoiceSends.push({ chatId, text, choices, controls });
    },
    close: async (chatId: string, messageId: string): Promise<void> => {
      this.selectionCloses.push({ chatId, messageId });
    },
  };
  private handler: ((event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>) | undefined;

  onEvent(handler: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>): {
    dispose(): void;
  } {
    this.handler = handler;
    return { dispose: () => (this.handler = undefined) };
  }

  async start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
  }

  async emit(event: RemoteInboundEvent): Promise<RemoteInboundDisposition> {
    if (!this.handler) return { kind: 'retry', reason: 'channel is not started' };
    return this.handler(event);
  }

  async send(
    chatId: string,
    text: string,
    options?: { correlationId?: string; signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<string[]> {
    if (this.sendError) throw new Error(this.sendError);
    this.sent.push({
      chatId,
      text,
      ...(options?.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options?.parseMode ? { parseMode: options.parseMode } : {}),
    });
    // Addressable like Telegram, so reply cleanup has an id to delete.
    return [`sent-${this.sent.length}`];
  }

  async retractPrompt(chatId: string, correlationId: string): Promise<void> {
    this.retracted.push({ chatId, correlationId });
  }

  async resolvePromptKeyboard(
    chatId: string,
    correlationId: string,
    keyboardMessageIds: readonly string[],
    approved: boolean,
  ): Promise<void> {
    if (this.resolveKeyboardError) throw new Error(this.resolveKeyboardError);
    this.resolvedKeyboards.push({ chatId, correlationId, keyboardMessageIds, approved });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    this.deleted.push({ chatId, messageId });
  }

  async handleHelpAction(
    event: Extract<RemoteInboundEvent, { kind: 'help_action' }>,
  ): Promise<RemoteInboundDisposition> {
    const help = new TelegramHelpMessages({
      sendInlineKeyboard: (chatId, text, buttons, options) =>
        this.sendInlineKeyboard(chatId, text, buttons, options),
      editInlineKeyboardMessage: async (chatId, messageId, text, buttons, options) => {
        if (!this.editInlineKeyboardMessage)
          throw new Error('inline message editing is unavailable');
        await this.editInlineKeyboardMessage(chatId, messageId, text, buttons, options);
      },
      deleteMessage: (chatId, messageId) => this.deleteMessage(chatId, messageId),
    });
    return help.handleAction(event);
  }

  async sendHelp(
    chatId: string,
    text: string,
    options?: Parameters<NonNullable<RemoteChannel['sendHelp']>>[2],
  ): Promise<void> {
    await this.sendInlineKeyboard(chatId, text, options?.buttons ?? [], options);
  }

  async editInlineKeyboardMessage(
    chatId: string,
    messageId: string,
    text: string,
    buttons: readonly RemoteContactButton[][],
    options?: { parseMode?: 'HTML' },
  ): Promise<void> {
    if (this.inlineEditError) throw new Error(this.inlineEditError);
    this.inlineEdits.push({ chatId, messageId, text, buttons, ...pageMode(options) });
  }

  async sendForceReply(
    chatId: string,
    text: string,
    placeholder: string,
  ): Promise<string | undefined> {
    this.forceReplies.push({ chatId, text, placeholder });
    return `force-${this.forceReplies.length}`;
  }

  async sendPhoto(chatId: string, filePath: string, caption: string): Promise<void> {
    this.photos.push({ chatId, filePath, caption });
  }

  async sendProgress(
    chatId: string,
    text: string,
    options?: { stopButton?: boolean },
  ): Promise<string> {
    this.progress.push({ chatId, text });
    const messageId = String(this.progress.length);
    if (options?.stopButton) this.stopButtons.add(messageId);
    return messageId;
  }

  async sendInlineKeyboard(
    chatId: string,
    text: string,
    buttons: readonly RemoteContactButton[][],
    options?: { parseMode?: 'HTML' },
  ): Promise<string> {
    this.inlineKeyboards.push({ chatId, text, buttons, ...pageMode(options) });
    return `keyboard-${this.inlineKeyboards.length}`;
  }

  async answerCallbackQuery(callbackId: string, text?: string): Promise<void> {
    this.callbackAnswers.push({ callbackId, ...(text ? { text } : {}) });
  }

  async clearInlineKeyboard(chatId: string, messageId: string): Promise<void> {
    this.clearedKeyboards.push({ chatId, messageId });
  }

  async replaceInlineKeyboard(
    chatId: string,
    messageId: string,
    buttons: readonly RemoteContactButton[][],
  ): Promise<void> {
    this.inlineKeyboardReplacements.push({ chatId, messageId, buttons });
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    options?: { stopButton?: boolean },
  ): Promise<void> {
    this.edits.push({ chatId, messageId, text });
    // Like Telegram: an edit without the keyboard removes it.
    if (options?.stopButton) this.stopButtons.add(messageId);
    else this.stopButtons.delete(messageId);
  }
}

function pageMode(options?: { parseMode?: 'HTML' }): { parseMode?: 'HTML' } {
  return options?.parseMode ? { parseMode: options.parseMode } : {};
}
