import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import { remoteDedupKey } from './RemoteRequestStore';
import {
  RemoteInboundEventSchema,
  type RemoteChannel,
  type RemoteInboundDisposition,
  type RemoteInboundEvent,
} from './types';
import type { RemoteAuditLog } from './RemoteAuditLog';
import { RemoteRateLimiter } from './RemoteRateLimiter';
import { RemoteOutboxDelivery } from './RemoteOutboxDelivery';
import { handleRemoteCommand } from './RemoteCommandHandler';
import { RemoteApprovalBridge } from './RemoteApprovalBridge';
import type { RemoteAttachmentStore } from './RemoteAttachmentStore';
import { RemoteAgentProgress } from './RemoteAgentProgress';
import { admitRemotePrompt, parseSteerCommand } from './RemotePromptAdmission';
import { drainRemoteQueue } from './RemoteQueueDrain';

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
  private readonly progress: RemoteAgentProgress;
  private progressSubscription: { dispose(): void } | undefined;

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
    this.progress = new RemoteAgentProgress(
      channel,
      this.abort.signal,
      (chatId) => this.auth.canDeliver(this.channel.name, chatId),
      Math.min(options.maxMessageChars, 3_900),
      1_500,
      options.onError,
    );
  }

  async start(): Promise<void> {
    await this.store.load();
    this.accepting = true;
    this.subscription = this.channel.onEvent((event) => this.handle(event));
    this.approvals.start();
    await this.channel.start(this.abort.signal);
    this.progressSubscription = this.host.onAgentProgress?.((event) => this.progress.handle(event));
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
    this.progress.updateMaxMessageChars(Math.min(options.maxMessageChars, 3_900));
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.abort.abort();
    this.subscription?.dispose();
    this.subscription = undefined;
    this.progressSubscription?.dispose();
    this.progressSubscription = undefined;
    this.approvals.stop();
    await Promise.allSettled(
      [...this.activeConversations].map((conversationId) => this.host.cancel(conversationId)),
    );
    await Promise.allSettled([...this.drains.values()]);
    await this.progress.dispose();
    await this.outbox.stop();
  }

  /**
   * Enqueue a host-originated notification (e.g. a compaction progress line)
   * for every chat on THIS transport bound to the conversation, then wake the
   * delivery loop. `notifyOutbox` is a durable write only; without the kick an
   * idle outbox would sit on the item until an unrelated retry. Filtering by
   * this channel's name is what keeps a Telegram+WhatsApp setup from
   * double-delivering: each transport's controller only reaches its own chats.
   */
  async enqueueHostNotification(conversationId: string, text: string): Promise<void> {
    const bindings = this.store.bindingsForConversation(conversationId, this.channel.name);
    if (bindings.length === 0) return;
    for (const binding of bindings) {
      await this.store.notifyOutbox(binding.channel, binding.chatId, text);
    }
    this.outbox.kick();
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
        await this.audit?.record(event, 'paired').catch(() => undefined);
        await this.channel.send(event.chatId, 'Forge remote pairing complete.', {
          signal: this.abort.signal,
        });
        return { kind: 'handled' };
      }
      return { kind: 'rejected', reason: 'sender is not paired' };
    }
    const gate = await this.auth.gate(event);
    if (gate.kind === 'challenge') {
      await this.audit?.record(event, 'authentication_challenge').catch(() => undefined);
      await this.channel.send(
        event.chatId,
        'Forge: authentication required. Enter your 6-digit authenticator code.',
        { signal: this.abort.signal },
      );
      return { kind: 'handled' };
    }
    if (gate.kind === 'failed') {
      await this.audit?.record(event, 'authentication_failed').catch(() => undefined);
      await this.channel.send(event.chatId, 'Forge: authentication failed.', {
        signal: this.abort.signal,
      });
      return { kind: 'handled' };
    }
    if (gate.kind === 'locked_out') {
      await this.audit?.record(event, 'authentication_locked_out').catch(() => undefined);
      return { kind: 'rejected', reason: 'remote authentication is temporarily locked' };
    }
    if (gate.kind === 'blocked') {
      return { kind: 'rejected', reason: 'remote authentication is required' };
    }
    if (gate.newlyAuthenticated) {
      await this.audit?.record(event, 'authenticated').catch(() => undefined);
      this.outbox.kick();
      const binding = this.store.binding(event.channel, event.chatId);
      if (binding) this.kickDrain(binding.conversationId);
      this.approvals.republish(event.chatId);
      await this.channel.send(event.chatId, 'Forge: authenticated.', { signal: this.abort.signal });
      return { kind: 'handled' };
    }
    if (event.kind === 'text' && event.text === '/lock') {
      this.auth.lock(event);
      await this.audit?.record(event, 'session_locked').catch(() => undefined);
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
    const steer = parseSteerCommand(event.text);
    if (steer.matched && !steer.text) {
      return { kind: 'rejected', reason: 'usage: /steer <prompt>' };
    }
    if (event.text.startsWith('/') && !steer.matched) {
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
    const result = await admitRemotePrompt(
      event,
      steer.text ?? event.text,
      key,
      steer.matched ? 'steer' : undefined,
      {
        channel: this.channel,
        store: this.store,
        host: this.host,
        options: this.options,
        isBusy: (conversationId) => this.isBusy(conversationId),
        kickDrain: (conversationId) => this.kickDrain(conversationId),
        audit: this.audit,
        onError: this.options.onError,
      },
    );
    if (result.kind !== 'rejected' && result.kind !== 'retry') this.auth.touch(event);
    return result;
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
    const drain = drainRemoteQueue(conversationId, {
      signal: this.abort.signal,
      channel: this.channel,
      store: this.store,
      auth: this.auth,
      host: this.host,
      progress: this.progress,
      outbox: this.outbox,
      activeConversations: this.activeConversations,
      attachmentStore: () => this.options.attachmentStore,
      isBusy: (id) => this.isBusy(id),
    })
      .catch((err) =>
        this.options.onError?.(
          `Forge remote queue stopped: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      .finally(() => this.drains.delete(conversationId));
    this.drains.set(conversationId, drain);
  }
}
