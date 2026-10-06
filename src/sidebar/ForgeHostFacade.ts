import type { AttachmentData } from './messageBridge';
import { chatCapMessage, MAX_CONVERSATIONS, type ConversationRuntime } from './sessionTypes';
import type { ForgeRequestOutcome } from './turnOutcome';
import type { CompactionEvent, CompactionOutcome, CompactionTrigger } from './CompactionService';
import type { HostActivityEvent, HostActivityListener } from './HostActivity';
import type { RequestChainStatus } from './RequestChainLifecycle';
import type { ToolApprovalRequestEvent, ToolApprovalSink } from './ToolApprovalService';
import type { AgentProgressEvent } from './AgentProgress';
import type { BackendProcess } from '../system/SystemReport';
import { recentExchanges, type ForgeExchange } from './sessionProjections';

export interface ForgeConversationSummary {
  id: string;
  title: string;
  activeModel: string | null;
  archived: boolean;
  updatedAt: number;
  /** Model requests that reported usage. */
  requestCount: number;
  /** Tool calls dispatched, successes and failures alike. */
  toolCallCount: number;
  /**
   * Compactions executed in this conversation (auto or manual), successes only.
   * Derived from `compaction.generation`, which increments by one per successful
   * compaction and is never reset — so it is the count, not a second counter.
   */
  compactCount: number;
  /**
   * Active agent time in ms, the status bar's timer: model work and tools,
   * approval waits excluded, the running turn included.
   */
  activeMs: number;
}

export interface ForgeHostStatus {
  activeConversationId: string;
  conversations: ForgeConversationSummary[];
  requestChains: RequestChainStatus[];
  streamingConversationIds: string[];
  pendingApproval?: ToolApprovalRequestEvent;
}

import type { UserQuestionSink } from './UserQuestionService';
import type { UserNotificationSink } from './UserNotificationService';

export interface ForgeHostFacade {
  createConversation(options?: { activate?: boolean }): Promise<ForgeConversationSummary>;
  restoreConversation(
    conversationId: string,
    options?: { activate?: boolean },
  ): Promise<ForgeConversationSummary>;
  /**
   * Why a new chat cannot be opened, as counts per reason; EMPTY when one can.
   *
   * The bus pre-flight asks this before accepting a `--new` message, so a
   * sender is told the truth at the moment it asks instead of after a 202.
   * `activate: false` matches a background open, which may not archive the
   * visible chat.
   */
  chatCapBlockers(options?: { activate?: boolean }): string[];
  send(
    conversationId: string,
    text: string,
    attachments?: AttachmentData[],
    options?: { remoteRequestId?: string },
  ): Promise<ForgeRequestOutcome>;
  /** Isolated, no-tools contact generation on a currently ready model slot. */
  runContactPrompt?(
    text: string,
    systemPromptText: string,
    options?: { web?: boolean },
  ): Promise<string>;
  cancelContactPrompts?(): void;
  cancel(conversationId: string): Promise<void>;
  /** Interrupt only the active turn so a durable steering prompt can run next. */
  interrupt(conversationId: string): Promise<void>;
  queueIntent(conversationId: string): void;
  addApprovalSink(sink: ToolApprovalSink): { dispose(): void };
  resolveApproval(id: string, approved: boolean): void;
  addQuestionSink(sink: UserQuestionSink): { dispose(): void };
  /** Answers an outstanding agent question from a non-local surface. */
  answerQuestion(id: string, text: string): boolean;
  /** Cancels an outstanding agent question when its remote presentation fails. */
  dismissQuestion(id: string): boolean;
  status(): ForgeHostStatus;
  /**
   * Clanker mode auto-approves every non-dangerous tool. It is deliberately NOT
   * a tool: a model able to switch it on could disable its own approval gate.
   * Only owner-authenticated surfaces (the sidebar, a remote `/clanker`) reach it.
   */
  clankerMode(): boolean;
  setClankerMode(on: boolean): void;
  /** Per-slot context for one conversation — `num_ctx / n_parallel`, not num_ctx. */
  contextBudget(conversationId: string): { used: number; max: number } | undefined;
  compact(
    conversationId: string,
    options?: {
      trigger?: CompactionTrigger;
      remoteOrigin?: { channel: string; chatId: string };
    },
  ): Promise<CompactionOutcome>;
  setConversationModel(conversationId: string, modelName: string | null): Promise<void>;
  unloadModels(): Promise<void>;
  /** Unload only the model this conversation uses; other loaded models stay. */
  unloadConversationModel(
    conversationId: string,
  ): Promise<{ model: string; wasLoaded: boolean; serverStopped?: boolean }>;
  restartModel(modelName: string): Promise<void>;
  /**
   * Model → pid for the llama-servers this window spawned, so a remote
   * `/system` can name Forge's own VRAM consumers. Optional on the same terms
   * as the subscriptions below: fakes that omit it keep compiling, and the
   * caller falls back to an untagged process list rather than failing.
   */
  backendProcesses?(): readonly BackendProcess[];
  /**
   * Subscribe to compaction progress events emitted by the sidebar.
   * Optional: fakes that omit it keep compiling; the runtime uses optional
   * chaining so a missing method is a no-op, not an error.
   */
  onCompactionEvent?(listener: (event: CompactionEvent) => void): { dispose(): void };
  /**
   * Subscribe to host state changes a paired chat cannot otherwise learn
   * about: a model unloaded, the backend restarted, a turn finished that the
   * chat did not ask for. Optional on the same terms as the hook above.
   */
  onHostActivity?(listener: HostActivityListener): { dispose(): void };
  /** Publish host news from outside the sidebar (the agent mesh's stand-in notice). */
  emitHostActivity?(event: HostActivityEvent): void;
  /**
   * How many transports are subscribed to host activity. The mesh's
   * pending-activity buffer reads this as delivery readiness: a facade that
   * exists but has no subscribed sink would deliver into the void, so the
   * buffer only flushes once this is > 0. Optional on the same terms as the
   * hooks above; unregistered means 0 (not ready).
   */
  hostActivityListenerCount?(): number;
  /**
   * Subscribe to agent-authored notify_user messages.
   *
   * The listener resolves to the number of chats it reached, which the tool
   * reports to the model verbatim -- so a transport that delivered nothing must
   * return 0 rather than pretending.
   */
  onUserNotification?(sink: UserNotificationSink): { dispose(): void };
  /**
   * Register the inverse of `onUserNotification`: how many chats a
   * notification WOULD reach, asked before sending rather than learned after.
   *
   * A turn needs the answer up front, because what it should do differs --
   * write the update in chat, or push it -- and by the time the count comes
   * back from a send it is too late to have made that choice. Optional on the
   * same terms as the hooks above; unregistered means reach 0.
   */
  setReachProbe?(probe: (conversationId: string) => number): { dispose(): void };
  onAgentProgress?(listener: (event: AgentProgressEvent) => void): { dispose(): void };
  /**
   * The last `limit` prompt/answer pairs of a conversation, oldest first.
   *
   * On the facade rather than reached for through `getOpenConversations()`:
   * this is the seam transports read the host through, and the one place that
   * already knows an archived conversation is still readable. Empty for a
   * conversation this window does not hold.
   */
  recentExchanges(conversationId: string, limit: number): ForgeExchange[];
}

export interface SidebarHostFacadeDeps {
  createConversation: (options: { activate?: boolean }) => ConversationRuntime | undefined;
  restoreConversation: (
    conversationId: string,
    options: { activate?: boolean },
  ) => ConversationRuntime | undefined;
  send: (
    conversationId: string,
    text: string,
    attachments?: AttachmentData[],
    options?: { remoteRequestId?: string },
  ) => Promise<ForgeRequestOutcome>;
  runContactPrompt?: (
    text: string,
    systemPromptText: string,
    options?: { web?: boolean },
  ) => Promise<string>;
  cancelContactPrompts?: () => void;
  cancel: (conversationId: string) => Promise<void>;
  interrupt: (conversationId: string) => Promise<void>;
  queueIntent: (conversationId: string) => void;
  addApprovalSink: (sink: ToolApprovalSink) => { dispose(): void };
  resolveApproval: (id: string, approved: boolean) => void;
  addQuestionSink: (sink: UserQuestionSink) => { dispose(): void };
  answerQuestion: (id: string, text: string) => boolean;
  dismissQuestion: (id: string) => boolean;
  getPendingApproval: () => ToolApprovalRequestEvent | undefined;
  getActiveConversationId: () => string;
  getOpenConversations: () => ConversationRuntime[];
  getArchivedConversations?: () => ConversationRuntime[];
  getRequestChains: () => RequestChainStatus[];
  getStreamingConversationIds: () => ReadonlySet<string>;
  getSessionActiveMs: (conversation: ConversationRuntime) => number;
  /** Counts per reason a slot cannot be freed; empty when a slot can be. */
  capBlockers: (options?: { activate?: boolean }) => string[];
  clankerMode: () => boolean;
  setClankerMode: (on: boolean) => void;
  contextBudget: (conversationId: string) => { used: number; max: number } | undefined;
  compact: (
    conversationId: string,
    options?: {
      trigger?: CompactionTrigger;
      remoteOrigin?: { channel: string; chatId: string };
    },
  ) => Promise<CompactionOutcome>;
  setConversationModel: (conversationId: string, modelName: string | null) => boolean;
  unloadModels: () => Promise<void>;
  unloadConversationModel: (
    conversationId: string,
  ) => Promise<{ model: string; wasLoaded: boolean; serverStopped?: boolean }>;
  restartModel: (modelName: string) => Promise<void>;
  backendProcesses?: () => readonly BackendProcess[];
  onCompactionEvent?: (listener: (event: CompactionEvent) => void) => { dispose(): void };
  onHostActivity?: (listener: HostActivityListener) => { dispose(): void };
  emitHostActivity?: (event: HostActivityEvent) => void;
  hostActivityListenerCount?: () => number;
  onUserNotification?: (sink: UserNotificationSink) => { dispose(): void };
  setReachProbe?: (probe: (conversationId: string) => number) => { dispose(): void };
  onAgentProgress: (listener: (event: AgentProgressEvent) => void) => { dispose(): void };
}

/**
 * A transport asked for a chat and none could be opened at the cap.
 *
 * Carries the reasons as data, not as one formatted sentence: `ConversationTabs`
 * owns the human wording, while a remote surface needs to decide what to tell a
 * phone and the bus needs to put the reasons in a JSON body. Existing callers
 * already catch a throw here, so only the error's shape changes.
 */
export class ChatCapacityError extends Error {
  constructor(
    /** Counts per reason, e.g. `7 running a turn`. Never empty in practice. */
    readonly atCapReason: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'ChatCapacityError';
  }
}

function summarize(
  conv: ConversationRuntime,
  archived: boolean,
  activeMs: number,
): ForgeConversationSummary {
  return {
    id: conv.id,
    title: conv.title,
    activeModel: conv.active_model ?? null,
    archived,
    updatedAt: conv.updatedAt,
    requestCount: conv.model_request_count ?? 0,
    toolCallCount: conv.tool_call_count ?? 0,
    compactCount: conv.compaction?.generation ?? 0,
    activeMs,
  };
}

/** Typed, addressed seam used by transports without manipulating sidebar focus. */
export class SidebarHostFacade implements ForgeHostFacade {
  constructor(private readonly deps: SidebarHostFacadeDeps) {}

  async createConversation(
    options: { activate?: boolean } = { activate: false },
  ): Promise<ForgeConversationSummary> {
    const conv = this.deps.createConversation({ activate: options.activate ?? false });
    if (!conv) {
      const reasons = this.deps.capBlockers(options);
      throw new ChatCapacityError(reasons, chatCapMessage(reasons));
    }
    return summarize(conv, false, this.deps.getSessionActiveMs(conv));
  }

  async restoreConversation(
    conversationId: string,
    options: { activate?: boolean } = { activate: false },
  ): Promise<ForgeConversationSummary> {
    const conv = this.deps.restoreConversation(conversationId, {
      activate: options.activate ?? false,
    });
    if (!conv) {
      if (this.deps.getOpenConversations().length >= MAX_CONVERSATIONS) {
        const reasons = this.deps.capBlockers(options);
        throw new ChatCapacityError(reasons, chatCapMessage(reasons));
      }
      throw new Error('Forge: conversation could not be restored.');
    }
    return summarize(conv, false, this.deps.getSessionActiveMs(conv));
  }

  chatCapBlockers(options: { activate?: boolean } = {}): string[] {
    return this.deps.capBlockers(options);
  }

  send(
    conversationId: string,
    text: string,
    attachments?: AttachmentData[],
    options?: { remoteRequestId?: string },
  ): Promise<ForgeRequestOutcome> {
    return this.deps.send(conversationId, text, attachments, options);
  }

  runContactPrompt(
    text: string,
    systemPromptText: string,
    options?: { web?: boolean },
  ): Promise<string> {
    if (!this.deps.runContactPrompt) throw new Error('Forge contact generation is unavailable.');
    return this.deps.runContactPrompt(text, systemPromptText, options);
  }

  cancelContactPrompts(): void {
    this.deps.cancelContactPrompts?.();
  }

  cancel(conversationId: string): Promise<void> {
    return this.deps.cancel(conversationId);
  }

  interrupt(conversationId: string): Promise<void> {
    return this.deps.interrupt(conversationId);
  }

  queueIntent(conversationId: string): void {
    this.deps.queueIntent(conversationId);
  }

  addApprovalSink(sink: ToolApprovalSink): { dispose(): void } {
    return this.deps.addApprovalSink(sink);
  }

  resolveApproval(id: string, approved: boolean): void {
    this.deps.resolveApproval(id, approved);
  }

  addQuestionSink(sink: UserQuestionSink): { dispose(): void } {
    return this.deps.addQuestionSink(sink);
  }

  answerQuestion(id: string, text: string): boolean {
    return this.deps.answerQuestion(id, text);
  }

  dismissQuestion(id: string): boolean {
    return this.deps.dismissQuestion(id);
  }

  clankerMode(): boolean {
    return this.deps.clankerMode();
  }

  setClankerMode(on: boolean): void {
    this.deps.setClankerMode(on);
  }

  contextBudget(conversationId: string): { used: number; max: number } | undefined {
    return this.deps.contextBudget(conversationId);
  }

  compact(
    conversationId: string,
    options?: {
      trigger?: CompactionTrigger;
      remoteOrigin?: { channel: string; chatId: string };
    },
  ): Promise<CompactionOutcome> {
    return this.deps.compact(conversationId, options);
  }

  async setConversationModel(conversationId: string, modelName: string | null): Promise<void> {
    if (!this.deps.setConversationModel(conversationId, modelName)) {
      throw new Error('Forge: conversation could not be found for model selection.');
    }
  }

  unloadModels(): Promise<void> {
    return this.deps.unloadModels();
  }

  unloadConversationModel(
    conversationId: string,
  ): Promise<{ model: string; wasLoaded: boolean; serverStopped?: boolean }> {
    return this.deps.unloadConversationModel(conversationId);
  }

  restartModel(modelName: string): Promise<void> {
    return this.deps.restartModel(modelName);
  }

  backendProcesses(): readonly BackendProcess[] {
    return this.deps.backendProcesses?.() ?? [];
  }

  onCompactionEvent(listener: (event: CompactionEvent) => void): { dispose(): void } {
    return this.deps.onCompactionEvent!(listener);
  }

  onHostActivity(listener: HostActivityListener): { dispose(): void } {
    return this.deps.onHostActivity!(listener);
  }

  emitHostActivity(event: HostActivityEvent): void {
    this.deps.emitHostActivity?.(event);
  }

  hostActivityListenerCount(): number {
    return this.deps.hostActivityListenerCount?.() ?? 0;
  }

  onUserNotification(sink: UserNotificationSink): { dispose(): void } {
    return this.deps.onUserNotification!(sink);
  }

  setReachProbe(probe: (conversationId: string) => number): { dispose(): void } {
    return this.deps.setReachProbe!(probe);
  }

  onAgentProgress(listener: (event: AgentProgressEvent) => void): { dispose(): void } {
    return this.deps.onAgentProgress(listener);
  }

  recentExchanges(conversationId: string, limit: number): ForgeExchange[] {
    const conversation = [
      ...this.deps.getOpenConversations(),
      ...(this.deps.getArchivedConversations?.() ?? []),
    ].find((candidate) => candidate.id === conversationId);
    return conversation ? recentExchanges(conversation.messages, limit) : [];
  }

  status(): ForgeHostStatus {
    const pendingApproval = this.deps.getPendingApproval();
    return {
      activeConversationId: this.deps.getActiveConversationId(),
      conversations: [
        ...this.deps
          .getOpenConversations()
          .map((conversation) =>
            summarize(conversation, false, this.deps.getSessionActiveMs(conversation)),
          ),
        ...(this.deps.getArchivedConversations?.() ?? []).map((conversation) =>
          summarize(conversation, true, this.deps.getSessionActiveMs(conversation)),
        ),
      ],
      requestChains: this.deps.getRequestChains(),
      streamingConversationIds: [...this.deps.getStreamingConversationIds()],
      ...(pendingApproval ? { pendingApproval } : {}),
    };
  }
}
