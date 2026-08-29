import { randomUUID } from 'crypto';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import { remoteDedupKey } from './RemoteRequestStore';
import {
  RemoteInboundEventSchema,
  type RemoteChannel,
  type RemoteInboundDisposition,
  type RemoteInboundEvent,
  type RemoteRequestRecord,
} from './types';

export interface RemoteControllerOptions {
  workspaceId: string;
  queueLimit: number;
  maxMessageChars: number;
}

/** Durable transport-independent admission, FIFO execution, and notification. */
export class RemoteController {
  private readonly abort = new AbortController();
  private readonly drains = new Map<string, Promise<void>>();
  private subscription: { dispose(): void } | undefined;
  private accepting = false;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly store: RemoteRequestStore,
    private readonly auth: RemoteAuth,
    private readonly host: ForgeHostFacade,
    private readonly options: RemoteControllerOptions,
  ) {}

  async start(): Promise<void> {
    await this.store.load();
    this.accepting = true;
    this.subscription = this.channel.onEvent((event) => this.handle(event));
    await this.channel.start(this.abort.signal);
    for (const request of this.store.queued()) this.kickDrain(request.conversationId);
    void this.flushOutbox();
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.abort.abort();
    this.subscription?.dispose();
    this.subscription = undefined;
    await Promise.allSettled([...this.drains.values()]);
  }

  async handle(raw: RemoteInboundEvent): Promise<RemoteInboundDisposition> {
    if (!this.accepting) return { kind: 'retry', reason: 'remote runtime is stopping' };
    const parsed = RemoteInboundEventSchema.safeParse(raw);
    if (!parsed.success) return { kind: 'rejected', reason: 'invalid remote event' };
    const event = parsed.data;
    if (event.chatType !== 'private') return { kind: 'rejected', reason: 'private chats only' };

    if (!(await this.auth.isOwner(event))) {
      if ((await this.auth.tryPair(event)) === 'paired') {
        await this.channel.send(event.chatId, 'Forge remote pairing complete.');
        return { kind: 'handled' };
      }
      return { kind: 'rejected', reason: 'sender is not paired' };
    }
    if (event.kind === 'action') {
      return { kind: 'rejected', reason: 'approval actions are not enabled yet' };
    }
    if (event.text.length > this.options.maxMessageChars) {
      return { kind: 'rejected', reason: 'message exceeds configured limit' };
    }
    if (event.text.startsWith('/')) return this.handleCommand(event);

    const key = remoteDedupKey(event.channel, event.chatId, event.providerMessageId);
    const duplicate = this.store.getByDedupKey(key);
    if (duplicate) {
      return { kind: 'duplicate', requestId: duplicate.id, state: duplicate.state };
    }
    let binding = this.store.binding(event.channel, event.chatId);
    if (!binding) {
      const conv = await this.host.createConversation({ activate: false });
      binding = {
        channel: event.channel,
        chatId: event.chatId,
        workspaceId: this.options.workspaceId,
        conversationId: conv.id,
      };
      await this.store.setBinding(binding);
    }
    const queued = this.store.queued(binding.conversationId);
    if (queued.length >= this.options.queueLimit) {
      return { kind: 'rejected', reason: 'remote queue is full' };
    }
    const busy = this.isBusy(binding.conversationId);
    const request: RemoteRequestRecord = {
      id: randomUUID(),
      dedupKey: key,
      channel: event.channel,
      chatId: event.chatId,
      providerMessageId: event.providerMessageId,
      conversationId: binding.conversationId,
      text: event.text,
      receivedAt: event.receivedAt,
      state: 'queued',
      updatedAt: Date.now(),
    };
    try {
      const inserted = await this.store.enqueue(request);
      if (!inserted) {
        const existing = this.store.getByDedupKey(key);
        if (!existing) return { kind: 'retry', reason: 'dedup state changed during admission' };
        return { kind: 'duplicate', requestId: existing.id, state: existing.state };
      }
    } catch (err) {
      return { kind: 'retry', reason: `durable admission failed: ${(err as Error).message}` };
    }
    if (busy) this.host.queueIntent(binding.conversationId);
    this.kickDrain(request.conversationId);
    return busy || queued.length > 0
      ? { kind: 'queued', requestId: request.id, position: queued.length + 1 }
      : { kind: 'accepted', requestId: request.id };
  }

  private async handleCommand(
    event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  ): Promise<RemoteInboundDisposition> {
    const [command, argument] = event.text.trim().split(/\s+/, 2);
    if (command === '/help') {
      await this.channel.send(
        event.chatId,
        'Forge commands: /status, /stop, /new, /resume <conversation-id>. /stop cancels the current request; queued requests remain queued.',
      );
      return { kind: 'handled' };
    }
    if (command === '/status') {
      const status = this.host.status();
      const binding = this.store.binding(event.channel, event.chatId);
      const queued = binding ? this.store.queued(binding.conversationId).length : 0;
      await this.channel.send(
        event.chatId,
        `Forge: ${status.requestChains.length} active request(s), ${queued} queued, ${status.streamingConversationIds.length} streaming.`,
      );
      return { kind: 'handled' };
    }
    if (command === '/stop') {
      const binding = this.store.binding(event.channel, event.chatId);
      if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
      await this.host.cancel(binding.conversationId);
      await this.channel.send(
        event.chatId,
        'Forge: current request stopped; queued requests remain queued.',
      );
      return { kind: 'handled' };
    }
    if (command === '/new') {
      const conv = await this.host.createConversation({ activate: false });
      await this.store.setBinding({
        channel: event.channel,
        chatId: event.chatId,
        workspaceId: this.options.workspaceId,
        conversationId: conv.id,
      });
      await this.channel.send(event.chatId, `Forge: bound to new conversation ${conv.id}.`);
      return { kind: 'handled' };
    }
    if (command === '/resume' && argument) {
      const conv = await this.host.restoreConversation(argument, { activate: false });
      await this.store.setBinding({
        channel: event.channel,
        chatId: event.chatId,
        workspaceId: this.options.workspaceId,
        conversationId: conv.id,
      });
      await this.channel.send(event.chatId, `Forge: resumed conversation ${conv.id}.`);
      return { kind: 'handled' };
    }
    return { kind: 'rejected', reason: 'unknown command' };
  }

  private isBusy(conversationId: string): boolean {
    const status = this.host.status();
    return (
      status.requestChains.some((chain) => chain.conversationId === conversationId) ||
      status.streamingConversationIds.includes(conversationId)
    );
  }

  private kickDrain(conversationId: string): void {
    if (this.drains.has(conversationId)) return;
    const drain = this.drain(conversationId)
      .catch(() => undefined)
      .finally(() => this.drains.delete(conversationId));
    this.drains.set(conversationId, drain);
  }

  private async drain(conversationId: string): Promise<void> {
    while (!this.abort.signal.aborted) {
      const next = this.store.queued(conversationId)[0];
      if (!next) return;
      if (this.isBusy(conversationId)) {
        await this.delay(250);
        continue;
      }
      await this.store.markRunning(next.id);
      try {
        const outcome = await this.host.send(conversationId, next.text);
        if (outcome.kind === 'completed') {
          await this.store.finish(next.id, 'completed', {
            finalText: outcome.finalText,
            notification: outcome.finalText || 'Forge request completed.',
          });
        } else if (outcome.kind === 'cancelled' || outcome.kind === 'interrupted') {
          await this.store.finish(next.id, 'cancelled', {
            ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
            notification: outcome.finalText || 'Forge request cancelled.',
          });
        } else {
          await this.store.finish(next.id, 'failed', {
            error: outcome.error,
            ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
            notification: `Forge request failed: ${outcome.error}`,
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await this.store.finish(next.id, 'failed', {
          error,
          notification: `Forge request failed: ${error}`,
        });
      }
      await this.flushOutbox();
    }
  }

  private async flushOutbox(): Promise<void> {
    for (const item of this.store.pendingOutbox()) {
      await this.store.markOutbox(item.id, 'sending');
      try {
        await this.channel.send(item.chatId, item.text.slice(0, this.options.maxMessageChars));
        await this.store.markOutbox(item.id, 'delivered');
      } catch {
        await this.store.markOutbox(item.id, 'pending');
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
