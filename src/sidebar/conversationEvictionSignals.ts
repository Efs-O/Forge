/**
 * One reading of the conversation eviction gate.
 *
 * The yes/no decision and the explanation of a refusal must come from the same
 * object, or a refusal can claim a reason the rule that produced it never saw.
 * This gathers the signals; `evictionGate.ts` alone decides what they mean.
 *
 * Split out of `wireSidebar` with its sources named rather than captured: a
 * captured `host` or `agentLoop` inside a 25-line closure is the kind of thing
 * that goes stale when the wiring around it is rebuilt, and a named source is
 * obviously a read of a collaborator.
 */
import { remoteEvictionSignals, type ConversationEvictionSignals } from './evictionGate';
import { pendingAgentAsksFor } from '../agentLinks/pendingAgentAsks';

export interface EvictionSignalSources {
  isStreaming: (id: string) => boolean;
  /** `undefined` means the queue state has not been reported yet. */
  isConversationQueued: (id: string) => boolean | undefined;
  /** `undefined` while the live webview has not reported its staged drafts. */
  isConversationDrafted: (id: string) => boolean | undefined;
  /** `undefined` means the remote store has not loaded; `false` means none configured. */
  remoteEvictionBlocks: (id: string) => boolean | undefined;
  pendingApprovalConversationIds: () => Set<string>;
  pendingQuestionConversationIds: () => Set<string>;
  hasPendingQuestion: (id: string) => boolean;
  requestChainConversations: () => readonly { conversationId: string }[];
  openConversations: () => readonly { id: string; opened_by?: string }[];
  isUnattended: (id: string) => boolean;
}

export function createConversationEvictionSignals(
  sources: EvictionSignalSources,
): (id: string) => ConversationEvictionSignals {
  return (id) => {
    const queued = sources.isConversationQueued(id);
    const drafted = sources.isConversationDrafted(id);
    const approvals = sources.pendingApprovalConversationIds();
    const questions = sources.pendingQuestionConversationIds();
    const requestChains = sources.requestChainConversations();
    const workerChatActive = sources
      .openConversations()
      .some(
        (worker) =>
          worker.opened_by === id &&
          (sources.isStreaming(worker.id) ||
            requestChains.some((chain) => chain.conversationId === worker.id)),
      );
    return {
      // Every signal here is activity or an unresolved prompt. A Keep/Undo
      // still undecided is deliberately absent: `disposeEvictedConversation`
      // keeps the checkpoint stack, so archiving no longer hides the undo.
      streaming: sources.isStreaming(id),
      activeRequestChain: requestChains.some((chain) => chain.conversationId === id),
      workerChatActive,
      unattended: sources.isUnattended(id),
      agentAskPending: pendingAgentAsksFor(id).length > 0,
      pendingApprovalActive: approvals.has(id),
      pendingApprovalQueued: approvals.has(id),
      pendingQuestion: sources.hasPendingQuestion(id),
      unattributedRequest: approvals.has('') || questions.has(''),
      // An unreported queue is `beforeWebviewQueueReport` alone; passing the
      // undefined here too made a refusal claim "12 with messages queued".
      hostQueue: queued === true,
      webviewQueue: queued === true,
      beforeWebviewQueueReport: queued === undefined,
      webviewDraft: drafted === true,
      beforeWebviewDraftReport: drafted === undefined,
      ...remoteEvictionSignals(sources.remoteEvictionBlocks(id)),
    };
  };
}
