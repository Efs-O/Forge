import type { AttachmentData } from './messageBridge';
import {
  chatCapMessage,
  MAX_CONVERSATIONS,
  type ConversationRuntime,
  type TitleSource,
} from './sessionTypes';
import { summarizeConversation } from './hostConversationSummary';
import type { ForgeRequestOutcome } from './turnOutcome';
import type { CompactionEvent, CompactionOutcome, CompactionTrigger } from './CompactionService';
import type { HostActivityEvent, HostActivityListener } from './HostActivity';
import type { RequestChainStatus } from './RequestChainLifecycle';
import type { ToolApprovalRequestEvent, ToolApprovalSink } from './ToolApprovalService';
import type { AgentProgressEvent } from './AgentProgress';
import type { BackendProcess } from '../system/SystemReport';
import { recentExchanges, type ForgeExchange } from './sessionProjections';
import type { AgentKind, AgentLink, AgentSender } from '../agentLinks/chatAgentLinks';
import type { InboundAgentSelection, InboundAgentTarget } from '../agentLinks/inboundAgentRouting';
import type { StructuredAnswer } from '../util/questionAnswers';
import type { AskAgentFacadeHandler, SidebarHostFacadeDeps } from './hostFacadeDeps';

export interface ForgeConversationSummary {
  id: string;
  title: string;
  /** Who the name came from: its first prompt, a person, or the retitle job. */
  titleSource?: TitleSource;
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
  /** Whether this chat currently runs with Clanker enabled. */
  clanker: boolean;
}

export interface ForgeHostStatus {
  activeConversationId: string;
  conversations: ForgeConversationSummary[];
  requestChains: RequestChainStatus[];
  streamingConversationIds: string[];
  /** Live model requests and tools, excluding question-only waits. */
  modelDemandConversationIds: string[];
  pendingApproval?: ToolApprovalRequestEvent;
}

import type { UserQuestionSink } from './UserQuestionService';
import type { UserNotificationSink } from './UserNotificationService';

export interface ForgeHostFacade {
  createConversation(options?: {
    activate?: boolean;
    openedBy?: string;
  }): Promise<ForgeConversationSummary>;
  restoreConversation(
    conversationId: string,
    options?: { activate?: boolean },
  ): Promise<ForgeConversationSummary>;
  /** Why opening a new chat is blocked, by reason; `activate: false` matches background opens. */
  chatCapBlockers(options?: { activate?: boolean }): string[];
  routeInboundAgent(
    sender: AgentSender,
    selection: InboundAgentSelection,
  ): Promise<InboundAgentTarget>;
  getAgentLink(conversationId: string, kind: AgentKind): AgentLink | undefined;
  askAgent: AskAgentFacadeHandler;
  showConversationNotice(conversationId: string, message: string): void;
  send(
    conversationId: string,
    text: string,
    attachments?: AttachmentData[],
    options?: {
      remoteRequestId?: string;
      sender?: import('../agentLinks/chatAgentLinks').AgentSenderMetadata;
    },
  ): Promise<ForgeRequestOutcome>;
  /** Isolated, no-tools contact generation on a currently ready model slot. */
  runContactPrompt?(
    text: string,
    systemPromptText: string,
    options?: { web?: boolean },
  ): Promise<string>;
  cancelContactPrompts?(): void;
  cancel(conversationId: string, reason?: string): Promise<void>;
  /** Interrupt only the active turn so a durable steering prompt can run next. */
  interrupt(conversationId: string): Promise<void>;
  queueIntent(conversationId: string): void;
  addApprovalSink(sink: ToolApprovalSink): { dispose(): void };
  pendingApprovalForConversation(conversationId: string): ToolApprovalRequestEvent | undefined;
  hasPendingQuestion(conversationId: string): boolean;
  resolveApproval(
    id: string,
    decision: import('./approvalMessages').ApprovalDecision,
    source: import('./approvalMessages').ApprovalAnswerSource,
  ): void;
  resetApprovals(conversationId: string): Promise<boolean>;
  addQuestionSink(sink: UserQuestionSink): { dispose(): void };
  /** Answers an outstanding agent question from a non-local surface. */
  answerQuestion(id: string, text: string): boolean;
  /** The addressed chat record, including one held in the overflow archive. */
  getConversation(conversationId: string): ConversationRuntime | undefined;
  answerQuestionStructured(id: string, answer: StructuredAnswer): boolean;
  skipQuestion(id: string): boolean;
  /** Cancels an outstanding agent question when its remote presentation fails. */
  dismissQuestion(id: string): boolean;
  status(): ForgeHostStatus;
  /**
   * Clanker mode for one chat and no other: keyed calls run with no card, and
   * anything with no key still gets a card. It is deliberately NOT a tool: a model
   * able to switch it on could disable its own approval gate. Only
   * owner-authenticated surfaces (the sidebar, a remote `/clanker`) reach it.
   */
  clankerMode(conversationId: string): boolean;
  setClankerMode(conversationId: string, on: boolean): void;
  /** Per-slot context for one conversation — `num_ctx / n_parallel`, not num_ctx. */
  contextBudget(conversationId: string): { used: number; max: number } | undefined;
  /** Measured context apportioned across system instructions, tools and transcript. */
  contextBreakdown(
    conversationId: string,
  ): { instructions: number; tools: number; conversation: number } | undefined;
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
  backendProcesses?(): readonly BackendProcess[];
  /** Optional compaction progress subscription; the runtime treats omission as a no-op. */
  onCompactionEvent?(listener: (event: CompactionEvent) => void): { dispose(): void };
  /** Optional host state subscription for paired chats (model, backend, or turn changes). */
  onHostActivity?(listener: HostActivityListener): { dispose(): void };
  /** Publish host news from outside the sidebar (the agent bus's progress notice). */
  emitHostActivity?(event: HostActivityEvent): void;
  /** Optional subscribed transport count; an omitted hook means 0 (not ready). */
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
  /**
   * Takes this turn's speed line for a conversation, once, or undefined: the
   * turn runner sums that turn's own server timings, and asking twice gets
   * undefined, so one turn's speed can only ever reach a phone once.
   */
  takeTurnSpeedLine?(conversationId: string): string | undefined;
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
  /** Renames a chat with a name the retitle job got from the model, marking the
   *  record `auto` so the next run leaves it alone; false when this workspace
   *  holds no chat with that id. Same path a rename from the sidebar uses. */
  applyAutoTitle?(conversationId: string, title: string): boolean;
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

/** Typed, addressed seam used by transports without manipulating sidebar focus. */
export class SidebarHostFacade implements ForgeHostFacade {
  constructor(private readonly deps: SidebarHostFacadeDeps) {}

  async createConversation(
    options: { activate?: boolean; openedBy?: string } = { activate: false },
  ): Promise<ForgeConversationSummary> {
    const conv = this.deps.createConversation({
      activate: options.activate ?? false,
      ...(options.openedBy ? { openedBy: options.openedBy } : {}),
    });
    if (!conv) {
      const reasons = this.deps.capBlockers(options);
      throw new ChatCapacityError(reasons, chatCapMessage(reasons));
    }
    return summarizeConversation(conv, false, this.deps.getSessionActiveMs(conv));
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
    return summarizeConversation(conv, false, this.deps.getSessionActiveMs(conv));
  }

  chatCapBlockers(options: { activate?: boolean } = {}): string[] {
    return this.deps.capBlockers(options);
  }

  routeInboundAgent(
    sender: AgentSender,
    selection: InboundAgentSelection,
  ): Promise<InboundAgentTarget> {
    return this.deps.routeInboundAgent(sender, selection);
  }

  getAgentLink(conversationId: string, kind: AgentKind): AgentLink | undefined {
    return this.deps.getAgentLink(conversationId, kind);
  }

  askAgent: AskAgentFacadeHandler = (...args) => this.deps.askAgent(...args);

  showConversationNotice(conversationId: string, message: string): void {
    this.deps.showConversationNotice(conversationId, message);
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

  cancel(conversationId: string, reason?: string): Promise<void> {
    return this.deps.cancel(conversationId, reason);
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

  pendingApprovalForConversation(conversationId: string): ToolApprovalRequestEvent | undefined {
    return this.deps.pendingApprovalForConversation(conversationId);
  }

  hasPendingQuestion(conversationId: string): boolean {
    return this.deps.hasPendingQuestion(conversationId);
  }

  resolveApproval(
    id: string,
    decision: import('./approvalMessages').ApprovalDecision,
    source: import('./approvalMessages').ApprovalAnswerSource,
  ): void {
    this.deps.resolveApproval(id, decision, source);
  }

  resetApprovals(conversationId: string): Promise<boolean> {
    return this.deps.resetApprovals?.(conversationId) ?? Promise.resolve(false);
  }

  addQuestionSink(sink: UserQuestionSink): { dispose(): void } {
    return this.deps.addQuestionSink(sink);
  }

  answerQuestion(id: string, text: string): boolean {
    return this.deps.answerQuestion(id, text);
  }

  answerQuestionStructured(id: string, answer: StructuredAnswer): boolean {
    return this.deps.answerQuestionStructured(id, answer);
  }

  skipQuestion(id: string): boolean {
    return this.deps.skipQuestion(id);
  }

  dismissQuestion(id: string): boolean {
    return this.deps.dismissQuestion(id);
  }

  clankerMode(conversationId: string): boolean {
    return this.deps.clankerMode(conversationId);
  }

  setClankerMode(conversationId: string, on: boolean): void {
    this.deps.setClankerMode(conversationId, on);
  }

  contextBudget(conversationId: string): { used: number; max: number } | undefined {
    return this.deps.contextBudget(conversationId);
  }

  contextBreakdown = (conversationId: string) => this.deps.contextBreakdown?.(conversationId);

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

  takeTurnSpeedLine(conversationId: string): string | undefined {
    return this.deps.takeTurnSpeedLine?.(conversationId);
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

  getConversation(conversationId: string): ConversationRuntime | undefined {
    return [
      ...this.deps.getOpenConversations(),
      ...(this.deps.getArchivedConversations?.() ?? []),
    ].find((conversation) => conversation.id === conversationId);
  }

  applyAutoTitle(conversationId: string, title: string): boolean {
    return this.deps.applyAutoTitle!(conversationId, title);
  }

  status(): ForgeHostStatus {
    const pendingApproval = this.deps.getPendingApproval();
    return {
      activeConversationId: this.deps.getActiveConversationId(),
      conversations: [
        ...this.deps
          .getOpenConversations()
          .map((conversation) =>
            summarizeConversation(conversation, false, this.deps.getSessionActiveMs(conversation)),
          ),
        ...(this.deps.getArchivedConversations?.() ?? []).map((conversation) =>
          summarizeConversation(conversation, true, this.deps.getSessionActiveMs(conversation)),
        ),
      ],
      requestChains: this.deps.getRequestChains(),
      streamingConversationIds: [...this.deps.getStreamingConversationIds()],
      modelDemandConversationIds: [...this.deps.getModelDemandConversationIds()],
      ...(pendingApproval ? { pendingApproval } : {}),
    };
  }
}
