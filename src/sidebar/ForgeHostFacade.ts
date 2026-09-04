import type { AttachmentData } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { ForgeRequestOutcome } from './turnOutcome';
import type { CompactionEvent, CompactionOutcome, CompactionTrigger } from './CompactionService';
import type { HostActivityListener } from './HostActivity';
import type { RequestChainStatus } from './RequestChainLifecycle';
import type { ToolApprovalRequestEvent, ToolApprovalSink } from './ToolApprovalService';
import type { AgentProgressEvent } from './AgentProgress';
import type { BackendProcess } from '../system/SystemReport';

export interface ForgeConversationSummary {
  id: string;
  title: string;
  activeModel: string | null;
  archived: boolean;
  updatedAt: number;
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
  send(
    conversationId: string,
    text: string,
    attachments?: AttachmentData[],
    options?: { remoteRequestId?: string },
  ): Promise<ForgeRequestOutcome>;
  cancel(conversationId: string): Promise<void>;
  /** Interrupt only the active turn so a durable steering prompt can run next. */
  interrupt(conversationId: string): Promise<void>;
  queueIntent(conversationId: string): void;
  addApprovalSink(sink: ToolApprovalSink): { dispose(): void };
  resolveApproval(id: string, approved: boolean): void;
  addQuestionSink(sink: UserQuestionSink): { dispose(): void };
  /** Answers an outstanding agent question from a non-local surface. */
  answerQuestion(id: string, text: string): boolean;
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
  /**
   * Subscribe to agent-authored notify_user messages.
   *
   * The listener resolves to the number of chats it reached, which the tool
   * reports to the model verbatim -- so a transport that delivered nothing must
   * return 0 rather than pretending.
   */
  onUserNotification?(sink: UserNotificationSink): { dispose(): void };
  onAgentProgress?(listener: (event: AgentProgressEvent) => void): { dispose(): void };
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
  cancel: (conversationId: string) => Promise<void>;
  interrupt: (conversationId: string) => Promise<void>;
  queueIntent: (conversationId: string) => void;
  addApprovalSink: (sink: ToolApprovalSink) => { dispose(): void };
  resolveApproval: (id: string, approved: boolean) => void;
  addQuestionSink: (sink: UserQuestionSink) => { dispose(): void };
  answerQuestion: (id: string, text: string) => boolean;
  getPendingApproval: () => ToolApprovalRequestEvent | undefined;
  getActiveConversationId: () => string;
  getOpenConversations: () => ConversationRuntime[];
  getArchivedConversations?: () => ConversationRuntime[];
  getRequestChains: () => RequestChainStatus[];
  getStreamingConversationIds: () => ReadonlySet<string>;
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
  restartModel: (modelName: string) => Promise<void>;
  backendProcesses?: () => readonly BackendProcess[];
  onCompactionEvent?: (listener: (event: CompactionEvent) => void) => { dispose(): void };
  onHostActivity?: (listener: HostActivityListener) => { dispose(): void };
  onUserNotification?: (sink: UserNotificationSink) => { dispose(): void };
  onAgentProgress: (listener: (event: AgentProgressEvent) => void) => { dispose(): void };
}

function summarize(conv: ConversationRuntime, archived: boolean): ForgeConversationSummary {
  return {
    id: conv.id,
    title: conv.title,
    activeModel: conv.active_model ?? null,
    archived,
    updatedAt: conv.updatedAt,
  };
}

/** Typed, addressed seam used by transports without manipulating sidebar focus. */
export class SidebarHostFacade implements ForgeHostFacade {
  constructor(private readonly deps: SidebarHostFacadeDeps) {}

  async createConversation(
    options: { activate?: boolean } = { activate: false },
  ): Promise<ForgeConversationSummary> {
    const conv = this.deps.createConversation({ activate: options.activate ?? false });
    if (!conv) throw new Error('Forge: maximum open conversations reached.');
    return summarize(conv, false);
  }

  async restoreConversation(
    conversationId: string,
    options: { activate?: boolean } = { activate: false },
  ): Promise<ForgeConversationSummary> {
    const conv = this.deps.restoreConversation(conversationId, {
      activate: options.activate ?? false,
    });
    if (!conv) throw new Error('Forge: conversation could not be restored.');
    return summarize(conv, false);
  }

  send(
    conversationId: string,
    text: string,
    attachments?: AttachmentData[],
    options?: { remoteRequestId?: string },
  ): Promise<ForgeRequestOutcome> {
    return this.deps.send(conversationId, text, attachments, options);
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

  onUserNotification(sink: UserNotificationSink): { dispose(): void } {
    return this.deps.onUserNotification!(sink);
  }

  onAgentProgress(listener: (event: AgentProgressEvent) => void): { dispose(): void } {
    return this.deps.onAgentProgress(listener);
  }

  status(): ForgeHostStatus {
    const pendingApproval = this.deps.getPendingApproval();
    return {
      activeConversationId: this.deps.getActiveConversationId(),
      conversations: [
        ...this.deps.getOpenConversations().map((conversation) => summarize(conversation, false)),
        ...(this.deps.getArchivedConversations?.() ?? []).map((conversation) =>
          summarize(conversation, true),
        ),
      ],
      requestChains: this.deps.getRequestChains(),
      streamingConversationIds: [...this.deps.getStreamingConversationIds()],
      ...(pendingApproval ? { pendingApproval } : {}),
    };
  }
}
