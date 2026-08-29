import type { AttachmentData } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { ForgeRequestOutcome } from './turnOutcome';
import type { RequestChainStatus } from './RequestChainLifecycle';
import type { ToolApprovalRequestEvent, ToolApprovalSink } from './ToolApprovalService';

export interface ForgeConversationSummary {
  id: string;
  title: string;
  activeModel: string | null;
  archived: boolean;
}

export interface ForgeHostStatus {
  activeConversationId: string;
  conversations: ForgeConversationSummary[];
  requestChains: RequestChainStatus[];
  streamingConversationIds: string[];
  pendingApproval?: ToolApprovalRequestEvent;
}

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
  queueIntent(conversationId: string): void;
  addApprovalSink(sink: ToolApprovalSink): { dispose(): void };
  resolveApproval(id: string, approved: boolean): void;
  status(): ForgeHostStatus;
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
  queueIntent: (conversationId: string) => void;
  addApprovalSink: (sink: ToolApprovalSink) => { dispose(): void };
  resolveApproval: (id: string, approved: boolean) => void;
  getPendingApproval: () => ToolApprovalRequestEvent | undefined;
  getActiveConversationId: () => string;
  getOpenConversations: () => ConversationRuntime[];
  getRequestChains: () => RequestChainStatus[];
  getStreamingConversationIds: () => ReadonlySet<string>;
}

function summarize(conv: ConversationRuntime): ForgeConversationSummary {
  return {
    id: conv.id,
    title: conv.title,
    activeModel: conv.active_model ?? null,
    archived: false,
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
    return summarize(conv);
  }

  async restoreConversation(
    conversationId: string,
    options: { activate?: boolean } = { activate: false },
  ): Promise<ForgeConversationSummary> {
    const conv = this.deps.restoreConversation(conversationId, {
      activate: options.activate ?? false,
    });
    if (!conv) throw new Error('Forge: conversation could not be restored.');
    return summarize(conv);
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

  queueIntent(conversationId: string): void {
    this.deps.queueIntent(conversationId);
  }

  addApprovalSink(sink: ToolApprovalSink): { dispose(): void } {
    return this.deps.addApprovalSink(sink);
  }

  resolveApproval(id: string, approved: boolean): void {
    this.deps.resolveApproval(id, approved);
  }

  status(): ForgeHostStatus {
    const pendingApproval = this.deps.getPendingApproval();
    return {
      activeConversationId: this.deps.getActiveConversationId(),
      conversations: this.deps.getOpenConversations().map(summarize),
      requestChains: this.deps.getRequestChains(),
      streamingConversationIds: [...this.deps.getStreamingConversationIds()],
      ...(pendingApproval ? { pendingApproval } : {}),
    };
  }
}
