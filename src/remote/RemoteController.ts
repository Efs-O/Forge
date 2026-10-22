import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import { remoteDedupKey } from './RemoteRequestStore';
import {
  RemoteInboundEventSchema,
  type RemoteChannel,
  type EphemeralKind,
  type RemoteInboundDisposition,
  type RemoteInboundEvent,
} from './types';
import type { RemoteAuditLog } from './RemoteAuditLog';
import { RemoteRateLimiter } from './RemoteRateLimiter';
import {
  armRemoteEphemeralMessage,
  ephemeralRejection,
  sendRemoteEphemeralMessage,
} from './RemoteEphemeralMessages';
import { createRemoteOutboxDelivery, RemoteOutboxDelivery } from './RemoteOutboxDelivery';
import { buildRemoteCommandDeps, workspaceContextOf } from './remoteCommandDeps';
import { applyRemoteAuthGate } from './remoteAuthGate';
import { RemoteApprovalBridge } from './RemoteApprovalBridge';
import { RemoteQuestionBridge } from './RemoteQuestionBridge';
import { CommandCleanupScheduler } from './CommandCleanupScheduler';
import { RemoteAgentProgress, CLOCK_INTERVAL_MS } from './RemoteAgentProgress';
import { HostProgressOpener } from './remoteHostProgress';
import { RemoteNotificationFanout } from './RemoteNotificationFanout';
import type { RemotePromptAdmissionDeps } from './RemotePromptAdmission';
import { routeRemoteText } from './remoteTextRouting';
import { startRemoteSessionRecovery } from './RemoteSessionRecovery';
import { drainRemoteQueue } from './RemoteQueueDrain';
import { RemotePendingPrompt } from './RemotePendingPrompt';
import { buildSpokenGateContext, type VoiceBridgeBundle } from './RemoteVoiceBridge';
import type { RemoteSpeechDelivery } from './RemoteSpeechDelivery';
import { handleRemoteSelectionAction } from './RemoteSelectionPager';
import type { RemoteControllerOptions } from './remoteControllerOptions';
import type { TelegramContactService } from './TelegramContactService';
import { handleRemoteSendNow } from './remoteSendNow';
import { handleRemoteStopAction } from './RemoteStopActions';
import { RemoteAgentAsk } from './remoteAgentAsk';
import { handleRemoteReportCallback } from './RemoteReportCallbacks';
export type { RemoteControllerOptions };
/** Durable transport-independent admission, FIFO execution, and notification. */
export class RemoteController {
  private readonly abort = new AbortController();
  private readonly drains = new Map<string, Promise<void>>();
  private subscription: { dispose(): void } | undefined;
  private accepting = false;
  private readonly activeConversations = new Set<string>();
  private readonly fanout: RemoteNotificationFanout;
  private rateLimiter: RemoteRateLimiter;
  /** Public so the jobs outbox watcher can kick delivery. */
  readonly outbox: RemoteOutboxDelivery;
  private readonly approvals: RemoteApprovalBridge;
  private readonly questions: RemoteQuestionBridge;
  private readonly progress: RemoteAgentProgress;
  /** Live draft previews shared by progress and Stop. */
  private readonly hostProgress: HostProgressOpener;
  private readonly pending = new RemotePendingPrompt();
  private readonly agentAsk = new RemoteAgentAsk();
  private readonly agentOriginTurns = new Set<string>();
  /** Best-effort deletion of processed owner commands from Telegram. */
  private readonly commandCleanup: CommandCleanupScheduler;
  private readonly sendTransientMessage: (chatId: string, text: string) => Promise<void>;
  armEphemeralMessage = (chatId: string, messageIds: string[], kind: EphemeralKind): void => {
    armRemoteEphemeralMessage(this.commandCleanup, chatId, messageIds, kind);
  };
  private progressSubscription: { dispose(): void } | undefined;
  private get promptDeps(): RemotePromptAdmissionDeps & {
    restoreConversation: (conversationId: string) => Promise<unknown>;
  } {
    return {
      channel: this.channel,
      store: this.store,
      host: this.host,
      options: this.options,
      isBusy: (conversationId) => this.isBusy(conversationId),
      kickDrain: (conversationId) => this.kickDrain(conversationId),
      audit: this.audit,
      onError: this.options.onError,
      restoreConversation: (conversationId) =>
        this.host.restoreConversation(conversationId, { activate: false }),
    };
  }
  constructor(
    private readonly channel: RemoteChannel,
    private readonly store: RemoteRequestStore,
    private readonly auth: RemoteAuth,
    private readonly host: ForgeHostFacade,
    private options: RemoteControllerOptions,
    private readonly audit?: RemoteAuditLog,
    /** Absent when `voice.enabled` is false. Held here, not in `options`: its
     *  per-chat draft state must survive a config reload. */
    private readonly voice?: VoiceBridgeBundle | undefined,
    /** Absent when `voice.output.enabled` is false; replies stay text-only. */
    speech?: RemoteSpeechDelivery | undefined,
    private readonly contactService?: TelegramContactService,
  ) {
    this.rateLimiter = new RemoteRateLimiter(options.rateLimitPerMinute);
    this.commandCleanup = new CommandCleanupScheduler({
      channel,
      signal: this.abort.signal,
      delaySeconds: () => this.options.deleteCommandMessagesAfter ?? 0,
      replyDelaySeconds: () => this.options.deleteCommandRepliesAfter ?? 0,
      onError: this.options.onError,
    });
    this.sendTransientMessage = (chatId, text) =>
      sendRemoteEphemeralMessage(channel, this.commandCleanup, chatId, text, this.abort.signal);
    this.outbox = createRemoteOutboxDelivery({
      channel,
      store,
      auth,
      signal: this.abort.signal,
      options,
      speech,
      commandCleanup: this.commandCleanup,
    });
    // Both bridges share the same chat round-trip dependencies.
    const bridgeDeps = [
      channel,
      store,
      auth,
      host,
      this.abort.signal,
      options.maxMessageChars,
      options.onError,
      this.commandCleanup,
    ] as const;
    this.approvals = new RemoteApprovalBridge(...bridgeDeps);
    this.questions = new RemoteQuestionBridge(...bridgeDeps);
    this.progress = new RemoteAgentProgress(
      channel,
      this.abort.signal,
      (chatId) => this.auth.canDeliver(this.channel.name, chatId),
      Math.min(options.maxMessageChars, 3_900),
      1_000,
      options.onError,
      (chatId, messageIds, delaySeconds) =>
        this.commandCleanup.armAfter(chatId, messageIds, delaySeconds),
      CLOCK_INTERVAL_MS,
    );
    this.fanout = new RemoteNotificationFanout({
      store,
      channelName: channel.name,
      workspaceId: options.workspaceId,
      kick: () => this.outbox.kick(),
      ownsProgress: (conversationId) => this.progress.owns(conversationId),
    });
    this.hostProgress = new HostProgressOpener({
      channel,
      signal: this.abort.signal,
      progress: this.progress,
      target: (conversationId) =>
        this.agentOriginTurns.has(conversationId)
          ? undefined
          : this.fanout.mirrorTarget(conversationId),
      canDeliver: (chatId) => this.auth.canDeliver(this.channel.name, chatId),
      enqueuePrompt: (chatId, text) => this.enqueuePromptOutbox(chatId, text),
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  async start(): Promise<void> {
    await this.store.load();
    startRemoteSessionRecovery(
      this.store,
      this.channel.name,
      this.outbox,
      this.abort.signal,
      this.options.onError,
    );
    this.accepting = true;
    this.subscription = this.channel.onEvent((event) => this.handle(event));
    this.approvals.start();
    this.questions.start();
    await this.channel.start(this.abort.signal);
    this.progressSubscription = this.host.onAgentProgress?.((event) => {
      this.hostProgress.handle(event);
      if (event.kind === 'end') this.agentOriginTurns.delete(event.conversationId);
    });
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
    this.outbox.updateUnlockBacklogMax(options.unlockBacklogMax);
  }
  /** Drops held prompts on unpair so a new owner cannot inherit the old owner's queued work. */
  forgetChannel(channel: RemoteInboundEvent['channel']): void {
    this.pending.clearChannel(channel);
  }
  async stop(): Promise<void> {
    this.accepting = false;
    this.commandCleanup.dispose();
    this.abort.abort();
    this.agentAsk.dispose();
    this.subscription?.dispose();
    this.subscription = undefined;
    this.progressSubscription?.dispose();
    this.progressSubscription = undefined;
    this.approvals.stop();
    this.questions.stop();
    this.contactService?.dispose();
    await Promise.allSettled(
      [...this.activeConversations].map((conversationId) => this.host.cancel(conversationId)),
    );
    await Promise.allSettled([...this.drains.values()]);
    this.hostProgress.dispose();
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
  deliverHostImage(conversationId: string, filePath: string, caption: string): number {
    return this.progress.deliverImage(conversationId, filePath, caption);
  }
  reachForConversation(conversationId: string): number {
    return this.fanout.countOn(conversationId);
  }
  async broadcastHostNotification(text: string, ephemeral?: boolean): Promise<number> {
    return this.fanout.toWorkspace(text, ephemeral);
  }
  async mirrorTurn(conversationId: string, text: string): Promise<number> {
    return this.fanout.mirrorTurn(conversationId, text);
  }
  mirrorPrompt(conversationId: string, text: string): Promise<number> {
    if (this.agentOriginTurns.has(conversationId)) return Promise.resolve(0);
    const chatId = this.fanout.mirrorTarget(conversationId);
    if (!chatId) return Promise.resolve(0);
    if (
      !this.progress.mirrorPrompt(conversationId, text, (target, prompt) =>
        this.enqueuePromptOutbox(target, prompt),
      )
    ) {
      this.hostProgress.stashPrompt(conversationId, chatId, text);
    }
    return Promise.resolve(1);
  }
  suppressAgentOriginProgress(conversationId: string): void {
    this.agentOriginTurns.add(conversationId);
  }
  async reportTurnFailure(conversationId: string, text: string): Promise<number> {
    return this.fanout.failureNotice(conversationId, text);
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
  retireQueuedReceipt(requestId: string): Promise<void> {
    return this.channel.retireQueuedReceipt?.(requestId) ?? Promise.resolve();
  }
  async handle(raw: RemoteInboundEvent): Promise<RemoteInboundDisposition> {
    if (!this.accepting) return { kind: 'retry', reason: 'remote runtime is stopping' };
    const parsed = RemoteInboundEventSchema.safeParse(raw);
    if (!parsed.success) return ephemeralRejection('invalid remote event');
    const event = parsed.data;
    await this.audit?.record(event, 'inbound').catch(() => undefined);
    if (event.chatType !== 'private') {
      const groupResult = await this.contactService?.handleGroup(event);
      return groupResult ?? ephemeralRejection('private chats only');
    }
    const authGate = await applyRemoteAuthGate(event, {
      auth: this.auth,
      ...(this.contactService ? { contactService: this.contactService } : {}),
      ...(this.audit ? { audit: this.audit } : {}),
      sendTransientMessage: this.sendTransientMessage,
      pending: this.pending,
      outbox: this.outbox,
      store: this.store,
      kickDrain: (conversationId) => this.kickDrain(conversationId),
      approvals: this.approvals,
      questions: this.questions,
      inactivityTimeoutMinutes: () => this.options.inactivityTimeoutMinutes,
      rehandle: (heldEvent) => this.handle(heldEvent),
      scheduleCommandCleanup: (commandEvent) => this.commandCleanup.schedule(commandEvent),
    });
    if (!('continue' in authGate)) return authGate;
    const nonce = authGate.nonce;
    if (!this.rateLimiter.allow(`${event.channel}:${event.senderId}:${event.chatId}`)) {
      return ephemeralRejection('remote rate limit exceeded');
    }
    if (
      event.kind === 'job_action' ||
      event.kind === 'queue_action' ||
      event.kind === 'agent_ask_action'
    ) {
      const result = await handleRemoteReportCallback(event, {
        channel: this.channel,
        store: this.store,
        agentAsk: this.agentAsk,
        commandContext: (textEvent) => this.commandContext(textEvent),
        routeText: (textEvent, overrides) => this.routeText(textEvent, overrides),
      });
      if (!result) return ephemeralRejection('unsupported report callback');
      if (result.kind !== 'rejected' && result.kind !== 'retry') this.auth.touch(event);
      return result;
    }
    if (event.kind === 'selection' && event.action === 'pick') {
      const result = await handleRemoteReportCallback(event, {
        channel: this.channel,
        store: this.store,
        agentAsk: this.agentAsk,
        commandContext: (textEvent) => this.commandContext(textEvent),
        routeText: (textEvent, overrides) => this.routeText(textEvent, overrides),
      });
      if (!result) return ephemeralRejection('selection pick is unavailable');
      if (result.kind !== 'rejected' && result.kind !== 'retry') this.auth.touch(event);
      return result;
    }
    if (event.kind === 'selection') {
      const result = await handleRemoteSelectionAction(
        event,
        {
          channel: this.channel,
          store: this.store,
          host: this.host,
          signal: this.abort.signal,
          modelEntries: this.options.modelEntries,
          workspaceAliases: this.options.workspaceAliases,
          ...workspaceContextOf(this.options),
        },
        remoteDedupKey(event.channel, event.chatId, event.providerMessageId),
      );
      if (result.kind !== 'rejected' && result.kind !== 'retry') this.auth.touch(event);
      return result;
    }
    if (event.kind === 'help_action') return this.channel.handleHelpAction(event);
    if (event.kind === 'question_action') {
      const result = await this.questions.handleAction(event);
      if (result.kind !== 'rejected' && result.kind !== 'retry') this.auth.touch(event);
      return result;
    }
    if (event.kind === 'action') {
      if (!this.approvals.resolveAction(event, nonce)) {
        return { kind: 'rejected', reason: 'approval is stale or not owned by this chat' };
      }
      this.auth.touch(event);
      return { kind: 'handled' };
    }
    if (event.kind === 'contact_action') {
      return (
        (await this.contactService?.handleAction(event)) ?? {
          kind: 'rejected',
          reason: 'contact service unavailable',
        }
      );
    }
    if (event.kind === 'stop_action') {
      return handleRemoteStopAction(event, {
        channel: this.channel,
        progress: this.progress,
        store: this.store,
        auth: this.auth,
        host: this.host,
        ...(this.options.onError ? { onError: this.options.onError } : {}),
      });
    }
    if (event.kind === 'send_now_action') {
      return handleRemoteSendNow(event, {
        channel: this.channel,
        store: this.store,
        auth: this.auth,
        host: this.host,
        ...(this.audit ? { audit: this.audit } : {}),
        isBusy: (conversationId) => this.isBusy(conversationId),
        kickDrain: (conversationId) => this.kickDrain(conversationId),
        ...(this.options.onError ? { onError: this.options.onError } : {}),
      });
    }
    if (event.kind === 'unsupported_media') {
      // An explicit answer beats silence. The old behaviour was to drop the
      // update while the cursor advanced, so sending a video looked like Forge
      // being offline. The rejection is ephemeral: it is a notice about a
      // message that is already gone from the conversation's point of view, and
      // `ephemeral: true` is what arms its deletion in the acknowledgement path.
      return ephemeralRejection(`This media type isn't supported yet: ${event.mediaType}.`);
    }
    if (event.kind === 'voice') {
      if (!this.voice) {
        return ephemeralRejection('voice input is disabled (set voice.enabled in config)');
      }
      const result = await this.voice.bridge.handle(
        event,
        buildSpokenGateContext(event, nonce, {
          pendingGates: (chatId) => this.approvals.pendingGates(chatId),
          resolveSpoken: (gateId, approve, chatId, nonce) =>
            this.approvals.resolveSpoken(gateId, approve, chatId, nonce),
          conversationFor: (channel, chatId) => this.store.binding(channel, chatId)?.conversationId,
          interrupt: (conversationId) => void this.host.interrupt(conversationId),
        }),
      );
      if (result.kind !== 'rejected' && result.kind !== 'retry') this.auth.touch(event);
      return result;
    }
    const redirected = this.agentAsk.consume(event);
    return this.routeText(redirected ?? event);
  }
  private routeText(
    event: Extract<RemoteInboundEvent, { kind: 'text' }>,
    overrides?: Pick<
      import('./RemoteCommandHandler').RemoteCommandContext,
      'telegramEditMessageId' | 'telegramJobTarget'
    >,
  ): Promise<RemoteInboundDisposition> {
    return routeRemoteText(event, {
      maxMessageChars: this.options.maxMessageChars,
      promptDeps: this.promptDeps,
      acknowledge: this.sendTransientMessage,
      onError: this.options.onError,
      answerQuestion: (chatId, text) => this.questions.answerText(chatId, text),
      voice: this.voice,
      say: (chatId, text) =>
        this.channel.send(chatId, text, { signal: this.abort.signal }).then(() => undefined),
      rerun: (next) => this.handle(next),
      touch: (touched) => this.auth.touch(touched),
      commandContext: (command) => ({ ...this.commandContext(command), ...overrides }),
      scheduleCommandCleanup: (command) => this.commandCleanup.schedule(command),
    });
  }
  private commandContext(event: Extract<RemoteInboundEvent, { kind: 'text' }>) {
    return buildRemoteCommandDeps(
      {
        channel: this.channel,
        store: this.store,
        host: this.host,
        signal: this.abort.signal,
        commandCleanup: this.commandCleanup,
        options: () => this.options,
        totpEnrolled: () => this.auth.totpEnrolled(this.channel.name),
        ...(this.contactService
          ? { contactCommands: this.contactService.handleOwnerCommand.bind(this.contactService) }
          : {}),
      },
      event,
      {
        isNotifyOn: (chatId) => this.isNotifyOn(chatId),
        setNotify: (chatId, on) => this.setNotify(chatId, on),
        isMirrorOn: (chatId) => this.isMirrorOn(chatId),
        setMirror: (chatId, on) => this.setMirror(chatId, on),
        promptDeps: () => this.promptDeps,
      },
    );
  }
  private async enqueuePromptOutbox(chatId: string, text: string): Promise<void> {
    await this.store.notifyOutbox(this.channel.name, chatId, text);
    this.outbox.kick();
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
      ...(this.options.onError ? { onError: this.options.onError } : {}),
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
