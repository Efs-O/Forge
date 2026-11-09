/**
 * What `SidebarHostFacade` forwards to: the shape of the collaborators it is
 * built on, kept apart from the facade class so that file stays about behaviour
 * rather than about a 76-line list of function types. Every entry here is
 * supplied by `createSidebarHostFacade` from a collaborator `wireSidebar`
 * already built — this is construction, not policy.
 */
import type { AttachmentData } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import type { ForgeRequestOutcome } from './turnOutcome';
import type { CompactionEvent, CompactionOutcome, CompactionTrigger } from './CompactionService';
import type { HostActivityEvent, HostActivityListener } from './HostActivity';
import type { RequestChainStatus } from './RequestChainLifecycle';
import type { ToolApprovalRequestEvent, ToolApprovalSink } from './ToolApprovalService';
import type { AgentProgressEvent } from './AgentProgress';
import type { BackendProcess } from '../system/SystemReport';
import type { AgentKind, AgentLink, AgentSender } from '../agentLinks/chatAgentLinks';
import type { InboundAgentSelection, InboundAgentTarget } from '../agentLinks/inboundAgentRouting';
import type { AskAgentRequest, AskAgentResult } from '../agentLinks/askAgentService';
import type { StructuredAnswer } from '../util/questionAnswers';
import type { UserQuestionSink } from './UserQuestionService';
import type { UserNotificationSink } from './UserNotificationService';

/** The ask-agent call a facade exposes, with its two progress callbacks. */
export type AskAgentFacadeHandler = (
  conversationId: string,
  request: AskAgentRequest,
  signal: AbortSignal,
  onSessionLinked?: (link: AgentLink) => void,
  onAccepted?: (link: AgentLink) => void,
) => Promise<AskAgentResult>;

export interface SidebarHostFacadeDeps {
  createConversation: (options: {
    activate?: boolean;
    openedBy?: string;
  }) => ConversationRuntime | undefined;
  restoreConversation: (
    conversationId: string,
    options: { activate?: boolean },
  ) => ConversationRuntime | undefined;
  send: (
    conversationId: string,
    text: string,
    attachments?: AttachmentData[],
    options?: {
      remoteRequestId?: string;
      sender?: import('../agentLinks/chatAgentLinks').AgentSenderMetadata;
    },
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
  pendingApprovalForConversation: (conversationId: string) => ToolApprovalRequestEvent | undefined;
  hasPendingQuestion: (conversationId: string) => boolean;
  resolveApproval: (id: string, decision: import('./approvalMessages').ApprovalDecision) => void;
  resetApprovals?: (conversationId: string) => Promise<boolean>;
  addQuestionSink: (sink: UserQuestionSink) => { dispose(): void };
  answerQuestion: (id: string, text: string) => boolean;
  answerQuestionStructured: (id: string, answer: StructuredAnswer) => boolean;
  skipQuestion: (id: string) => boolean;
  dismissQuestion: (id: string) => boolean;
  getPendingApproval: () => ToolApprovalRequestEvent | undefined;
  getActiveConversationId: () => string;
  getOpenConversations: () => ConversationRuntime[];
  getArchivedConversations?: () => ConversationRuntime[];
  getRequestChains: () => RequestChainStatus[];
  getStreamingConversationIds: () => ReadonlySet<string>;
  getModelDemandConversationIds: () => ReadonlySet<string>;
  getSessionActiveMs: (conversation: ConversationRuntime) => number;
  /** Counts per reason a slot cannot be freed; empty when a slot can be. */
  capBlockers: (options?: { activate?: boolean }) => string[];
  routeInboundAgent: (
    sender: AgentSender,
    selection: InboundAgentSelection,
  ) => Promise<InboundAgentTarget>;
  getAgentLink: (conversationId: string, kind: AgentKind) => AgentLink | undefined;
  askAgent: AskAgentFacadeHandler;
  showConversationNotice: (conversationId: string, message: string) => void;
  clankerMode: (conversationId: string) => boolean;
  setClankerMode: (conversationId: string, on: boolean) => void;
  contextBudget: (conversationId: string) => { used: number; max: number } | undefined;
  contextBreakdown?: (
    conversationId: string,
  ) => { instructions: number; tools: number; conversation: number } | undefined;
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
  /**
   * Takes this turn's speed line for a conversation, once, or undefined. The
   * turn runner sums that turn's own server timings; asking twice gets
   * undefined the second time, so one turn's speed reaches a phone at most once.
   */
  takeTurnSpeedLine?: (conversationId: string) => string | undefined;
  onAgentProgress: (listener: (event: AgentProgressEvent) => void) => { dispose(): void };
  applyAutoTitle?: (conversationId: string, title: string) => boolean;
}
