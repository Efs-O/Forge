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
import { RemoteQuestionBridge } from './RemoteQuestionBridge';
import type { RemoteAttachmentStore } from './RemoteAttachmentStore';
import { RemoteAgentProgress } from './RemoteAgentProgress';
import { RemoteNotificationFanout } from './RemoteNotificationFanout';
import { admitRemotePrompt, isRemoteCommand, parseSteerCommand } from './RemotePromptAdmission';
import { drainRemoteQueue } from './RemoteQueueDrain';
import { RemotePendingPrompt } from './RemotePendingPrompt';
import { handleRemoteSelectionAction } from './RemoteSelectionPager';

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
  /** Alias whose configured path resolves to this window's root, if any. */
  currentWorkspaceAlias?: string | undefined;
  /** Display name of the folder this window has open, alias or not. */
  currentWorkspaceName?: string | undefined;
  switchWorkspace?: ((alias: string, channel: string, chatId: string) => Promise<void>) | undefined;
  inactivityTimeoutMinutes?: number;
  setInactivityTimeout?: ((minutes: number) => Promise<void>) | undefined;
  reloadWindow?: (() => Promise<void>) | undefined;
  onError?: (message: string) => void;
}

/** Durable transport-independent admission, FIFO execution, and notification. */
export class RemoteController {
  private readonly abort = new AbortController();
  private readonly drains = new Map<string, Promise<void>>();
  private subscription: { dispose(): void } | undefined;
  private accepting = false;
  private readonly activeConversations = new Set<string>();
  private readonly fanout: RemoteNotificationFanout;
  private rateLimiter: RemoteRateLimiter;
  private readonly outbox: RemoteOutboxDelivery;
  private readonly approvals: RemoteApprovalBridge;
  private readonly questions: RemoteQuestionBridge;
  private readonly progress: RemoteAgentProgress;
  private readonly pending = new RemotePendingPrompt();
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
    this.questions = new RemoteQuestionBridge(
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
    this.fanout = new RemoteNotificationFanout({
      store,
      channelName: channel.name,
      workspaceId: options.workspaceId,
      kick: () => this.outbox.kick(),
      ownsProgress: (conversationId) => this.progress.owns(conversationId),
    });
  }

  async start(): Promise<void> {
    await this.store.load();
    this.accepting = true;
    this.subscription = this.channel.onEvent((event) => this.handle(event));
    this.approvals.start();
    this.questions.start();
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
    this.questions.updateMaxMessageChars(options.maxMessageChars);
    this.progress.updateMaxMessageChars(Math.min(options.maxMessageChars, 3_900));
  }

  /**
   * Drops anything held for a channel whose owner has just been unpaired.
   * A held prompt outlives session state otherwise, and the next owner to pair
   * would inherit the last one's queued work on their first successful code.
   */
  forgetChannel(channel: RemoteInboundEvent['channel']): void {
    this.pending.clearChannel(channel);
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.abort.abort();
    this.subscription?.dispose();
    this.subscription = undefined;
    this.progressSubscription?.dispose();
    this.progressSubscription = undefined;
    this.approvals.stop();
    this.questions.stop();
    await Promise.allSettled(
      [...this.activeConversations].map((conversationId) => this.host.cancel(conversationId)),
    );
    await Promise.allSettled([...this.drains.values()]);
    await this.progress.dispose();
    await this.outbox.stop();
  }

  /**
   * Host-originated delivery. RemoteNotificationFanout owns who hears what and
   * what silences it; the controller keeps the numbers it returns, because
   * notify_user reports them straight to the model.
   */
  async enqueueHostNotification(conversationId: string, text: string): Promise<number> {
    return this.fanout.toConversation(conversationId, text);
  }

  async broadcastHostNotification(text: string): Promise<number> {
    return this.fanout.toWorkspace(text);
  }

  async mirrorTurn(conversationId: string, text: string): Promise<number> {
    return this.fanout.mirrorTurn(conversationId, text);
  }

  setMirror(chatId: string, on: boolean): void {
    this.fanout.setMirror(chatId, on);
  }

  isMirrorOn(chatId: string): boolean {
    return this.fanout.isMirrorOn(chatId);
  }

  setNotify(chatId: string, on: boolean): void {
    this.fanout.setNotify(chatId, on);
  }

  isNotifyOn(chatId: string): boolean {
    return this.fanout.isNotifyOn(chatId);
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
      // Hold a PROMPT rather than discarding it: the sender is already proven to
      // be the enrolled owner, so only the second factor is outstanding, and
      // retyping a long prompt on a phone is the whole cost of expiry.
      //
      // A command is never held. It costs nothing to retype, and holding one
      // fires it at a moment its sender did not choose: `/reload` typed at a
      // locked session came back with the code and reloaded the window, which
      // locked the session again — the same command arriving twice from one
      // keystroke. The reason a prompt is worth holding (it is expensive to
      // reproduce) is exactly the reason a command is not.
      const held = event.kind === 'text' && !isRemoteCommand(event.text);
      if (held) this.pending.hold(event);
      const idleMinutes = this.options.inactivityTimeoutMinutes ?? 30;
      const cause =
        gate.reason === 'expired'
          ? `session expired after ${idleMinutes} min idle`
          : 'authentication required';
      await this.channel.send(
        event.chatId,
        held
          ? `Forge: ${cause}. Your prompt is held and will run once you verify — ` +
              'send your 6-digit code.'
          : `Forge: ${cause}. Send your 6-digit code, then send the command again — ` +
              'commands are not held.',
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
      // Repeated wrong codes must not leave a prompt armed to fire later.
      this.pending.clear(event.channel, event.chatId);
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
      const heldPrompt = this.pending.take(event.channel, event.chatId);
      if (!heldPrompt) return { kind: 'handled' };
      await this.audit?.record(heldPrompt, 'held_prompt_replayed').catch(() => undefined);
      await this.channel.send(
        event.chatId,
        `Forge: running your held prompt — ${previewPrompt(heldPrompt.text)}`,
        { signal: this.abort.signal },
      );
      // Re-entering handle() is what keeps /commands, /steer, attachments and the
      // length check working on a replay. It cannot recurse: the held event now
      // gates as authorized without newlyAuthenticated, so this branch is
      // unreachable the second time.
      return await this.handle(heldPrompt);
    }
    if (event.kind === 'text' && event.text === '/lock') {
      this.auth.lock(event);
      this.pending.clear(event.channel, event.chatId);
      await this.audit?.record(event, 'session_locked').catch(() => undefined);
      await this.channel.send(event.chatId, 'Forge: remote session locked.', {
        signal: this.abort.signal,
      });
      return { kind: 'handled' };
    }
    if (!this.rateLimiter.allow(`${event.channel}:${event.senderId}:${event.chatId}`)) {
      return { kind: 'rejected', reason: 'remote rate limit exceeded' };
    }
    if (event.kind === 'selection') {
      const result = await handleRemoteSelectionAction(
        event,
        {
          channel: this.channel,
          store: this.store,
          host: this.host,
          signal: this.abort.signal,
          modelNames: this.options.modelNames,
          workspaceAliases: this.options.workspaceAliases,
          ...(this.options.currentWorkspaceAlias
            ? { currentWorkspaceAlias: this.options.currentWorkspaceAlias }
            : {}),
          ...(this.options.currentWorkspaceName
            ? { currentWorkspaceName: this.options.currentWorkspaceName }
            : {}),
        },
        remoteDedupKey(event.channel, event.chatId, event.providerMessageId),
      );
      if (result.kind !== 'rejected' && result.kind !== 'retry') this.auth.touch(event);
      return result;
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
    // An outstanding question owns the chat's next plain text: the agent is
    // blocked on it, so admitting the reply as a new prompt would both strand
    // the turn and queue work the user never asked for. Commands stay commands,
    // or a pending question would leave the chat with no way out.
    if (!event.text.startsWith('/') && this.questions.answerText(event.chatId, event.text)) {
      this.auth.touch(event);
      return { kind: 'handled' };
    }
    const key = remoteDedupKey(event.channel, event.chatId, event.providerMessageId);
    const steer = parseSteerCommand(event.text);
    if (steer.matched && !steer.text) {
      return { kind: 'rejected', reason: 'usage: /steer <prompt>' };
    }
    if (isRemoteCommand(event.text)) {
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
          // Without this, `/workspace list` never marks the current entry and
          // the "already in this workspace" guard on `/new <alias>` can never
          // fire — RemoteRuntime computes the alias and the handler reads it,
          // but nothing joined the two.
          ...(this.options.currentWorkspaceAlias
            ? { currentWorkspaceAlias: this.options.currentWorkspaceAlias }
            : {}),
          ...(this.options.currentWorkspaceName
            ? { currentWorkspaceName: this.options.currentWorkspaceName }
            : {}),
          notifyMute: {
            get: (chatId: string) => this.isNotifyOn(chatId),
            set: (chatId: string, on: boolean) => this.setNotify(chatId, on),
          },
          mirrorToggle: {
            get: (chatId: string) => this.isMirrorOn(chatId),
            set: (chatId: string, on: boolean) => this.setMirror(chatId, on),
          },
          ...(this.options.switchWorkspace
            ? { switchWorkspace: this.options.switchWorkspace }
            : {}),
          ...(this.options.setInactivityTimeout
            ? { setInactivityTimeout: this.options.setInactivityTimeout }
            : {}),
          ...(this.options.reloadWindow ? { reloadWindow: this.options.reloadWindow } : {}),
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

/** Short, single-line echo so a replayed prompt is never silent. */
function previewPrompt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > 120 ? `"${flat.slice(0, 120)}…"` : `"${flat}"`;
}
