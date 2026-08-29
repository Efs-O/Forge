import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';

export class FakeRemoteChannel implements RemoteChannel {
  readonly name = 'fake' as const;
  readonly sent: Array<{ chatId: string; text: string; correlationId?: string }> = [];
  readonly retracted: Array<{ chatId: string; correlationId: string }> = [];
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
}
