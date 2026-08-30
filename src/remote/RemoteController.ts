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
import type { RemoteAuditLog } from './RemoteAuditLog';
import { RemoteRateLimiter } from './RemoteRateLimiter';
import { RemoteOutboxDelivery } from './RemoteOutboxDelivery';
import { CONVERSATION_BUSY_ERROR } from '../sidebar/SendPipeline';
import { handleRemoteCommand } from './RemoteCommandHandler';
import { RemoteApprovalBridge } from './RemoteApprovalBridge';
import { withConversationIdentity } from './RemoteReplyIdentity';
import type { RemoteAttachmentStore } from './RemoteAttachmentStore';

export interface RemoteControllerOptions {
  workspaceId: string;
  queueLimit: number;
  maxMessageChars: number;
  rateLimitPerMinute: number;
  /** Snapshot of model names from the active, validated Forge config. */
  modelNames: readonly string[];
  attachmentStore?: RemoteAttachmentStore | undefined;
  attachmentsEnabled: boolean;
  acceptPdfAttachments: boolean;
  workspaceAliases: Readonly<Record<string, string>>;
  switchWorkspace?: ((alias: string, channel: string, chatId: string) => Promise<void>) | undefined;
  inactivityTimeoutMinutes?: number;
  setInactivityTimeout?: ((minutes: number) => Promise<void>) | undefined;
  onError?: (message: string) => void;
}

/** Durable transport-independent admission, FIFO execution, and notification. */
export class RemoteController {
  private readonly abort = new AbortController();
  private readonly drains = new Map<string, Promise<void>>();
  private subscription: { dispose(): void } | undefined;
  private accepting = false;
  private readonly activeConversations = new Set<string>();
  private rateLimiter: RemoteRateLimiter;
  private readonly outbox: RemoteOutboxDelivery;
  private readonly approvals: RemoteApprovalBridge;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly store: RemoteRequestStore,
    private readonly auth: RemoteAuth,
    private readonly host: ForgeHostFacade,
    private options: RemoteControllerOptions,
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
      (chatId) => this.auth.canDeliver(this.channel.name, chatId),
    );
    this.approvals = new RemoteApprovalBridge(
      channel,
      store,
      auth,
      host,
      this.abort.signal,
      options.maxMessageChars,
      options.onError,
    );
  }

  async start(): Promise<void> {
    await this.store.load();
    this.accepting = true;
    this.subscription = this.channel.onEvent((event) => this.handle(event));
    this.approvals.start();
    await this.channel.start(this.abort.signal);
    for (const request of this.store.queued(undefined, this.channel.name)) {
      this.kickDrain(request.conversationId);
    }
    this.outbox.start();
  }

  updateOptions(options: RemoteControllerOptions): void {
    this.options = options;
    this.rateLimiter = new RemoteRateLimiter(options.rateLimitPerMinute);
    this.outbox.updateMaxMessageChars(options.maxMessageChars);
    this.approvals.updateMaxMessageChars(options.maxMessageChars);
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.abort.abort();
    this.subscription?.dispose();
    this.subscription = undefined;
    this.approvals.stop();
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
    const gate = await this.auth.gate(event);
    if (gate.kind === 'challenge') {
      await this.channel.send(
        event.chatId,
        'Forge: authentication required. Enter your 6-digit authenticator code.',
        { signal: this.abort.signal },
      );
      return { kind: 'handled' };
    }
    if (gate.kind === 'failed') {
      await this.channel.send(event.chatId, 'Forge: authentication failed.', {
        signal: this.abort.signal,
      });
      return { kind: 'handled' };
    }
    if (gate.kind === 'locked_out') {
      return { kind: 'rejected', reason: 'remote authentication is temporarily locked' };
    }
    if (gate.kind === 'blocked') {
      return { kind: 'rejected', reason: 'remote authentication is required' };
    }
    if (gate.newlyAuthenticated) {
      this.outbox.kick();
      const binding = this.store.binding(event.channel, event.chatId);
      if (binding) this.kickDrain(binding.conversationId);
      this.approvals.republish(event.chatId);
      await this.channel.send(event.chatId, 'Forge: authenticated.', { signal: this.abort.signal });
      return { kind: 'handled' };
    }
    if (event.kind === 'text' && event.text === '/lock') {
      this.auth.lock(event);
      await this.channel.send(event.chatId, 'Forge: remote session locked.', {
        signal: this.abort.signal,
      });
      return { kind: 'handled' };
    }
    if (!this.rateLimiter.allow(`${event.channel}:${event.senderId}:${event.chatId}`)) {
      return { kind: 'rejected', reason: 'remote rate limit exceeded' };
    }
    if (event.kind === 'action') {
      if (!this.approvals.resolveAction(event, gate.nonce)) {
        return { kind: 'rejected', reason: 'approval is stale or not owned by this chat' };
      }
      this.auth.touch(event);
      return { kind: 'handled' };
    }
    if (event.text.length > this.options.maxMessageChars) {
      return { kind: 'rejected', reason: 'message exceeds configured limit' };
    }
    const key = remoteDedupKey(event.channel, event.chatId, event.providerMessageId);
    if (event.text.startsWith('/')) {
      const result = await handleRemoteCommand(
        event,
        {
          channel: this.channel,
          store: this.store,
          host: this.host,
          workspaceId: this.options.workspaceId,
          signal: this.abort.signal,
          inactivityTimeoutMinutes: this.options.inactivityTimeoutMinutes ?? 30,
          modelNames: this.options.modelNames,
          workspaceAliases: this.options.workspaceAliases,
          ...(this.options.switchWorkspace
            ? { switchWorkspace: this.options.switchWorkspace }
            : {}),
          ...(this.options.setInactivityTimeout
            ? { setInactivityTimeout: this.options.setInactivityTimeout }
            : {}),
        },
        key,
      );
      if (result.kind !== 'rejected' && result.kind !== 'retry') this.auth.touch(event);
      return result;
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
    const requestId = randomUUID();
    let attachments: RemoteRequestRecord['attachments'];
    if (event.attachments?.length) {
      if (!this.options.attachmentsEnabled) {
        return {
          kind: 'rejected',
          reason: 'remote attachments are disabled in Forge configuration',
        };
      }
      if (!this.options.attachmentStore) {
        return { kind: 'rejected', reason: 'remote attachments require an open workspace' };
      }
      try {
        const inboundAttachments = await Promise.all(
          event.attachments.map(async (attachment) => {
            if (attachment.mediaType === 'application/pdf' && !this.options.acceptPdfAttachments) {
              throw new Error('PDF attachments are disabled in Forge configuration');
            }
            if (attachment.data) return attachment;
            if (!this.channel.downloadAttachment)
              throw new Error('transport cannot download attachments');
            return this.channel.downloadAttachment(attachment);
          }),
        );
        attachments = await this.options.attachmentStore.save(
          binding.conversationId,
          requestId,
          inboundAttachments,
        );
      } catch (err) {
        return { kind: 'rejected', reason: `attachment rejected: ${(err as Error).message}` };
      }
    }
    const request: RemoteRequestRecord = {
      id: requestId,
      dedupKey: key,
      channel: event.channel,
      chatId: event.chatId,
      providerMessageId: event.providerMessageId,
      conversationId: binding.conversationId,
      text: event.text,
      ...(attachments ? { attachments } : {}),
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
    this.auth.touch(event);
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
      const queued = this.store.queued(conversationId, this.channel.name);
      const first = queued[0];
      if (!first) return;
      if (!(await this.auth.canDeliver(first.channel, first.chatId))) return;
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
      if (!(await this.auth.canDeliver(next.channel, next.chatId))) {
        await this.store.requeue(next.id);
        return;
      }
      this.activeConversations.add(conversationId);
      const progressId = await this.channel
        .sendProgress?.(next.chatId, 'Forge: working…', { signal: this.abort.signal })
        .catch(() => undefined);
      try {
        const attachments = next.attachments?.length
          ? await this.options.attachmentStore?.load(next.attachments)
          : undefined;
        if (next.attachments?.length && !attachments) {
          throw new Error('remote attachment sidecar is unavailable');
        }
        const outcome = await this.host.send(conversationId, next.text, attachments, {
          remoteRequestId: next.id,
        });
        if (outcome.kind === 'completed') {
          const notification = withConversationIdentity(
            this.store,
            this.host,
            next,
            outcome.finalText,
          );
          await this.store.finish(next.id, 'completed', {
            finalText: outcome.finalText,
            notification: notification ?? 'Forge request completed.',
            ...(notification ? { announceConversationId: next.conversationId } : {}),
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
        if (progressId) {
          await this.channel
            .editMessage?.(next.chatId, progressId, 'Forge: completed.', {
              signal: this.abort.signal,
            })
            .catch(() => undefined);
        }
        this.activeConversations.delete(conversationId);
      }
      this.outbox.kick();
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
