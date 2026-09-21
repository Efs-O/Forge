import type {
  RemoteChannel,
  RemoteContactButton,
  RemoteInboundDisposition,
  RemoteInboundEvent,
  RemoteSelectionChoice,
  RemoteSelectionControls,
} from './types';

export class FakeRemoteChannel implements RemoteChannel {
  readonly name: RemoteChannel['name'];
  readonly sent: Array<{ chatId: string; text: string; correlationId?: string }> = [];
  readonly retracted: Array<{ chatId: string; correlationId: string }> = [];
  /** Records command auto-cleanup deletes so tests can assert they fired. */
  readonly deleted: Array<{ chatId: string; messageId: string }> = [];
  readonly photos: Array<{ chatId: string; filePath: string; caption: string }> = [];
  readonly progress: Array<{ chatId: string; text: string }> = [];
  readonly inlineKeyboards: Array<{
    chatId: string;
    text: string;
    buttons: readonly RemoteContactButton[][];
    parseMode?: 'HTML';
  }> = [];
  readonly callbackAnswers: Array<{ callbackId: string; text?: string }> = [];
  readonly clearedKeyboards: Array<{ chatId: string; messageId: string }> = [];
  readonly edits: Array<{ chatId: string; messageId: string; text: string }> = [];
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
  sendHtml?: (chatId: string, html: string) => Promise<void>;
  declareHtmlSupport(): void {
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
    options?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<string[]> {
    this.sent.push({ chatId, text, ...(options?.correlationId ? options : {}) });
    // Addressable like Telegram, so reply cleanup has an id to delete.
    return [`sent-${this.sent.length}`];
  }

  async retractPrompt(chatId: string, correlationId: string): Promise<void> {
    this.retracted.push({ chatId, correlationId });
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    this.deleted.push({ chatId, messageId });
  }

  async handleHelpAction(): Promise<RemoteInboundDisposition> {
    return { kind: 'rejected', reason: 'help close is unavailable' };
  }

  async sendPhoto(chatId: string, filePath: string, caption: string): Promise<void> {
    this.photos.push({ chatId, filePath, caption });
  }

  async sendProgress(chatId: string, text: string): Promise<string> {
    this.progress.push({ chatId, text });
    return String(this.progress.length);
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

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    this.edits.push({ chatId, messageId, text });
  }
}

function pageMode(options?: { parseMode?: 'HTML' }): { parseMode?: 'HTML' } {
  return options?.parseMode ? { parseMode: options.parseMode } : {};
}
