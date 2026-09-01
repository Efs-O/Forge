import type {
  RemoteChannel,
  RemoteInboundDisposition,
  RemoteInboundEvent,
  RemoteSelectionControls,
} from './types';

export class FakeRemoteChannel implements RemoteChannel {
  readonly name = 'fake' as const;
  readonly sent: Array<{ chatId: string; text: string; correlationId?: string }> = [];
  readonly retracted: Array<{ chatId: string; correlationId: string }> = [];
  readonly progress: Array<{ chatId: string; text: string }> = [];
  readonly edits: Array<{ chatId: string; messageId: string; text: string }> = [];
  readonly selectionPageSends: Array<{
    chatId: string;
    text: string;
    controls: RemoteSelectionControls;
  }> = [];
  readonly selectionEdits: Array<{
    chatId: string;
    messageId: string;
    text: string;
    controls: RemoteSelectionControls;
  }> = [];
  readonly selectionCloses: Array<{ chatId: string; messageId: string }> = [];
  readonly selectionPages = {
    send: async (
      chatId: string,
      text: string,
      controls: RemoteSelectionControls,
    ): Promise<void> => {
      this.selectionPageSends.push({ chatId, text, controls });
    },
    edit: async (
      chatId: string,
      messageId: string,
      text: string,
      controls: RemoteSelectionControls,
    ): Promise<void> => {
      this.selectionEdits.push({ chatId, messageId, text, controls });
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
  ): Promise<void> {
    this.sent.push({ chatId, text, ...(options?.correlationId ? options : {}) });
  }

  async retractPrompt(chatId: string, correlationId: string): Promise<void> {
    this.retracted.push({ chatId, correlationId });
  }

  async sendProgress(chatId: string, text: string): Promise<string> {
    this.progress.push({ chatId, text });
    return String(this.progress.length);
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    this.edits.push({ chatId, messageId, text });
  }
}
