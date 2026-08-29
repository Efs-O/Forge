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
import type {
  ToolApprovalRequestEvent,
  ToolApprovalResolvedEvent,
} from '../sidebar/ToolApprovalService';
import type { RemoteAuditLog } from './RemoteAuditLog';
import { RemoteRateLimiter } from './RemoteRateLimiter';
import { RemoteOutboxDelivery } from './RemoteOutboxDelivery';
import { CONVERSATION_BUSY_ERROR } from '../sidebar/SendPipeline';
import { handleRemoteCommand } from './RemoteCommandHandler';

export interface RemoteControllerOptions {
  workspaceId: string;
  queueLimit: number;
  maxMessageChars: number;
  rateLimitPerMinute: number;
  onError?: (message: string) => void;
}

/** Durable transport-independent admission, FIFO execution, and notification. */
export class RemoteController {
  private readonly abort = new AbortController();
  private readonly drains = new Map<string, Promise<void>>();
  private subscription: { dispose(): void } | undefined;
  private accepting = false;
  private approvalSubscription: { dispose(): void } | undefined;
  private readonly remoteApprovals = new Map<
    string,
    { requestId: string; chatId: string; resolving?: boolean }
  >();
  private readonly activeConversations = new Set<string>();
  private readonly rateLimiter: RemoteRateLimiter;
  private readonly outbox: RemoteOutboxDelivery;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly store: RemoteRequestStore,
    private readonly auth: RemoteAuth,
    private readonly host: ForgeHostFacade,
    private readonly options: RemoteControllerOptions,
    private readonly audit?: RemoteAuditLog,
  ) {
    this.rateLimiter = new RemoteRateLimiter(options.rateLimitPerMinute);
    this.outbox = new RemoteOutboxDelivery(
      channel,
      store,
      options.maxMessageChars,
      this.abort.signal,
      1_000,
      options.onError,
    );
  }

  async start(): Promise<void> {
    await this.store.load();
    this.accepting = true;
    this.subscription = this.channel.onEvent((event) => this.handle(event));
    this.approvalSubscription = this.host.addApprovalSink({
      requested: (event) => this.onApprovalRequested(event),
      resolved: (event) => this.onApprovalResolved(event),
    });
    await this.channel.start(this.abort.signal);
    for (const request of this.store.queued(undefined, this.channel.name)) {
      this.kickDrain(request.conversationId);
    }
    this.outbox.start();
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.abort.abort();
    this.subscription?.dispose();
    this.subscription = undefined;
    this.approvalSubscription?.dispose();
    this.approvalSubscription = undefined;
    await Promise.allSettled(
      [...this.activeConversations].map((conversationId) => this.host.cancel(conversationId)),
    );
    await Promise.allSettled([...this.drains.values()]);
    await this.outbox.stop();
  }

  async handle(raw: RemoteInboundEvent): Promise<RemoteInboundDisposition> {
    if (!this.accepting) return { kind: 'retry', reason: 'remote runtime is stopping' };
    const parsed = RemoteInboundEventSchema.safeParse(raw);
    if (!parsed.success) return { kind: 'rejected', reason: 'invalid remote event' };
    const event = parsed.data;
    await this.audit?.record(event, 'inbound').catch(() => undefined);
    if (event.chatType !== 'private') return { kind: 'rejected', reason: 'private chats only' };

    if (!(await this.auth.isOwner(event))) {
      if ((await this.auth.tryPair(event)) === 'paired') {
        await this.channel.send(event.chatId, 'Forge remote pairing complete.', {
          signal: this.abort.signal,
        });
        return { kind: 'handled' };
      }
      return { kind: 'rejected', reason: 'sender is not paired' };
    }
    if (!this.rateLimiter.allow(`${event.channel}:${event.senderId}:${event.chatId}`)) {
      return { kind: 'rejected', reason: 'remote rate limit exceeded' };
    }
    if (event.kind === 'action') {
      const pending = this.remoteApprovals.get(event.correlationId);
      if (!pending || pending.chatId !== event.chatId || pending.resolving) {
        return { kind: 'rejected', reason: 'approval is stale or not owned by this chat' };
      }
      // Marked, not deleted: deleting here made `onApprovalResolved` bail on its
      // `!pending` guard, so a button press produced no confirmation and left
      // its keyboard on the message. The flag still rejects a replayed callback.
      pending.resolving = true;
      this.host.resolveApproval(event.correlationId, event.action === 'approve');
      return { kind: 'handled' };
    }
    if (event.text.length > this.options.maxMessageChars) {
      return { kind: 'rejected', reason: 'message exceeds configured limit' };
    }
    const key = remoteDedupKey(event.channel, event.chatId, event.providerMessageId);
    if (event.text.startsWith('/')) {
      return handleRemoteCommand(
        event,
        {
          channel: this.channel,
          store: this.store,
          host: this.host,
          workspaceId: this.options.workspaceId,
          signal: this.abort.signal,
        },
        key,
      );
    }

    const duplicate = this.store.getByDedupKey(key);
    if (duplicate) {
      return { kind: 'duplicate', requestId: duplicate.id, state: duplicate.state };
    }
    let binding = this.store.binding(event.channel, event.chatId);
    if (binding && binding.workspaceId !== this.options.workspaceId) {
      return { kind: 'rejected', reason: 'chat is bound to a different workspace' };
    }
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
      admittedAt: Date.now(),
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
    await this.audit
      ?.record(event, busy ? 'request_queued' : 'request_accepted', request.id)
      .catch(() => undefined);
    this.kickDrain(request.conversationId);
    return busy || queued.length > 0
      ? { kind: 'queued', requestId: request.id, position: queued.length + 1 }
      : { kind: 'accepted', requestId: request.id };
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
      .catch((err) =>
        this.options.onError?.(
          `Forge remote queue stopped: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      .finally(() => this.drains.delete(conversationId));
    this.drains.set(conversationId, drain);
  }

  private async drain(conversationId: string): Promise<void> {
    while (!this.abort.signal.aborted) {
      if (this.isBusy(conversationId)) {
        await this.delay(250);
        continue;
      }
      const next = await this.store.claimNext(conversationId, this.channel.name);
      if (!next) {
        if (this.store.queued(conversationId, this.channel.name).length === 0) return;
        await this.delay(250);
        continue;
      }
      if (this.abort.signal.aborted) {
        await this.store.requeue(next.id);
        return;
      }
      this.activeConversations.add(conversationId);
      try {
        const outcome = await this.host.send(conversationId, next.text, undefined, {
          remoteRequestId: next.id,
        });
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
        } else if (outcome.error === CONVERSATION_BUSY_ERROR) {
          await this.store.requeue(next.id);
          await this.delay(250);
          continue;
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
      } finally {
        this.activeConversations.delete(conversationId);
      }
      this.outbox.kick();
    }
  }

  private onApprovalRequested(event: ToolApprovalRequestEvent): void {
    if (!event.conversationId) return;
    const chain = this.host
      .status()
      .requestChains.find((item) => item.conversationId === event.conversationId);
    if (!chain?.remoteRequestId) return;
    const request = this.store.getRequest(chain.remoteRequestId);
    if (!request || request.channel !== this.channel.name) return;
    this.remoteApprovals.set(event.id, { requestId: request.id, chatId: request.chatId });
    const danger = event.dangerous ? ' DANGEROUS' : '';
    void this.channel
      .send(
        request.chatId,
        `Forge approval${danger}: ${event.toolName}\n${event.detail}`.slice(
          0,
          this.options.maxMessageChars,
        ),
        { correlationId: event.id, signal: this.abort.signal },
      )
      .catch((err) =>
        this.options.onError?.(
          `Forge remote approval delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  private onApprovalResolved(event: ToolApprovalResolvedEvent): void {
    const pending = this.remoteApprovals.get(event.id);
    if (!pending) return;
    this.remoteApprovals.delete(event.id);
    // No correlationId on the confirmation: passing it attached a SECOND live
    // approve/deny keyboard to the "approved/denied" notice itself.
    void this.channel
      .retractPrompt?.(pending.chatId, event.id, this.abort.signal)
      .catch(() => undefined);
    void this.channel
      .send(
        pending.chatId,
        `Forge approval ${event.approved ? 'approved' : 'denied'} (${event.reason}).`,
        { signal: this.abort.signal },
      )
      .catch((err) =>
        this.options.onError?.(
          `Forge remote approval update failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
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
