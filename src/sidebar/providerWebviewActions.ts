/**
 * Builds the `WebviewActions` bundle `routeWebviewMessage` dispatches into.
 *
 * Split out of `SidebarProvider` for the 500-line `max-lines` stop: the provider
 * was at 495 and the Jobs section needed three more webview actions plus its own
 * lifecycle, which it could not fit. The provider keeps its methods; this file
 * names the hand-offs, and `webviewMessageRouter.ts` stays the single switch. A
 * new webview action now costs a capability here rather than provider lines.
 *
 * Every entry is a thunk over the provider's own subsystems, so nothing is
 * captured at construction time and a subsystem that is replaced later (the
 * sidebar session, the view) is read fresh on the message that needs it.
 */
import type { AgentLoop } from './AgentLoop';
import type { ChatAttachmentStore } from './ChatAttachmentStore';
import type { ConversationTabs } from './ConversationTabs';
import type { IBackendPool } from '../backend/BackendPool';
import type { SlashCommandHandler } from './SlashCommandHandler';
import type { SidebarPromptRouter } from './backgroundExitNotice';
import type { UserQuestionService } from './UserQuestionService';
import type { ForgeHostFacade } from './ForgeHostFacade';
import type { HostToWebview } from './messageBridge';
import { storeHistoryPanelSize } from './historyPanelSizeStore';
import type { WebviewQueueState } from './evictionGate';
import type { JobsPanelBridge } from './jobPanelUpdates';
import type { SessionContentSearch } from './sessionContentSearch';
import type * as vscode from 'vscode';
import { createWebviewSendAction } from './turnMirrorWiring';
import { openAttachment } from './attachmentAccess';
import { logWebviewDiagnostic } from './webviewDiagnostics';
import { postActivityViewSetting } from './activityViewSetting';
import type { WebviewActions } from './webviewMessageRouter';

/** Everything the webview actions close over — the provider's internals, by reference. */
export interface ProviderWebviewCapabilities {
  post: (msg: HostToWebview) => void;
  postModels: () => void;
  postSessionSync: () => void;
  postTokenBudget: () => void;
  postWorkspaceInfo: () => void;
  /** The sidebar's current view: attachment URIs and previews need it. */
  getView: () => vscode.WebviewView | undefined;
  /** Read live, not captured: the sidebar session is reassigned as chats open and close. */
  activeConversationId: () => string;
  pool: IBackendPool;
  tabs: ConversationTabs;
  agentLoop: AgentLoop;
  questions: UserQuestionService;
  slashHandler: SlashCommandHandler;
  promptRouter: SidebarPromptRouter;
  /** Cancels a chat's pending `ask_agent` before its close disposes the checkpoint stack it commits into. */
  cancelAgentAsk: (conversationId: string) => void;
  webviewQueue: WebviewQueueState;
  attachmentStore?: ChatAttachmentStore;
  hostFacade: () => ForgeHostFacade;
  getRemoteStatus: () => { transports: string[]; paired: boolean };
  /** The Jobs panel bridge, or undefined when this window has no job store. */
  jobsBridge: () => JobsPanelBridge | undefined;
  /**
   * The sessions panel's content-search bridge. A thunk like everything else
   * here, because the provider builds it once and the webview messages arrive
   * long after: a window whose provider was built without one (a test) must not
   * make the search message throw.
   */
  sessionSearch?: () => SessionContentSearch | undefined;
  /**
   * The machine-wide store the history panel's saved size lives in. Read as a
   * thunk like everything else here: activation hands `context.globalState` over
   * once, but a window whose provider was built without one (a test, or a
   * headless activation) must not make the resize message throw.
   */
  globalState: () => vscode.Memento | undefined;
  /** Provider-level actions that are not a subsystem call. */
  undo: () => Promise<string[]>;
  keep: () => Promise<void>;
  reviewCheckpoint: () => Promise<void>;
  newConversation: () => void;
}

/** The webview's whole action set, built from the provider's capabilities. */
export function createProviderWebviewActions(caps: ProviderWebviewCapabilities): WebviewActions {
  const activeId = (): string => caps.activeConversationId();
  const openJobsPanel = (panelId: number): void => {
    const bridge = caps.jobsBridge();
    // Without a store the section cannot fill itself; say so rather than leave
    // the webview waiting for a snapshot that will never come.
    if (!bridge) {
      caps.post({ type: 'error', message: 'Forge: this window has no job store to list.' });
      return;
    }
    bridge.openPanel(panelId);
  };
  return {
    post: caps.post,
    postModels: caps.postModels,
    postSessionSync: caps.postSessionSync,
    postActivityView: () => postActivityViewSetting(caps.post),
    postTokenBudget: caps.postTokenBudget,
    postWorkspaceInfo: caps.postWorkspaceInfo,
    isBackendReady: () => caps.pool.isAnyReady(),
    /** Every chat this window can reach, open or archived, with its own Clanker
     *  state: a reloaded webview has no flags at all, and a tab restored from the
     *  archive mid-session needs the flag its record carries. Both are read through
     *  the queue, so the banner and the queue that answers the calls agree.
     */
    getClankerStates: () =>
      caps
        .hostFacade()
        .status()
        .conversations.map((conversation) => ({
          conversationId: conversation.id,
          enabled: caps.agentLoop.getClankerMode(conversation.id),
        })),
    getRemoteStatus: caps.getRemoteStatus,
    pendingQuestions: () => caps.questions.pendingQuestions(),
    pendingApproval: () => caps.agentLoop.pendingApproval(),
    send: createWebviewSendAction(
      (event) => caps.hostFacade().emitHostActivity?.(event),
      activeId,
      caps.promptRouter.route.bind(caps.promptRouter),
    ),
    cancelTell: (conversationId, tellId) => caps.promptRouter.cancelTell(conversationId, tellId),
    sendQueuedNow: (conversationId, tellId) =>
      caps.promptRouter.sendQueuedNow(conversationId, tellId),
    // The facade's cancel: it also aborts this chat's pending ask_agent exchanges.
    cancel: () => void caps.hostFacade().cancel(activeId()),
    answerQuestion: (id, answer) => caps.questions.answerStructured(id, answer),
    skipQuestion: (id) => caps.questions.skip(id),
    switchModel: (name) => caps.tabs.pinModel(name),
    undo: caps.undo,
    keep: caps.keep,
    reviewCheckpoint: caps.reviewCheckpoint,
    newConversation: caps.newConversation,
    switchConversation: (id) => caps.tabs.switch(id),
    closeConversation: (id) => {
      // Before the close disposes the checkpoint stack the ask commits into.
      caps.cancelAgentAsk(id);
      void caps.tabs.close(id);
    },
    restoreConversation: (id) => caps.tabs.restore(id),
    deleteConversation: (id) => void caps.tabs.deleteConversation(id),
    renameConversation: (id, title) => caps.tabs.rename(id, title),
    resetApprovals: (conversationId) => void caps.slashHandler.resetApprovals(conversationId),
    runSlashCommand: (id, agent) => void caps.slashHandler.handle(id, agent),
    openFile: (path, line, beside) => caps.agentLoop.openFile(path, { line, beside }),
    openAttachment: (relativePath) =>
      openAttachment({ store: caps.attachmentStore, view: caps.getView }, relativePath),
    resolveConfirmation: (id, approved) => caps.agentLoop.resolveConfirmation(id, approved),
    recordWebviewDiagnostic: (message) => logWebviewDiagnostic(message),
    queuedConversationIds: (ids) => {
      caps.webviewQueue.report(ids);
      caps.tabs.refreshRetention();
    },
    draftBearingConversationIds: (ids) => {
      caps.webviewQueue.reportDrafts(ids);
      caps.tabs.refreshRetention();
    },
    setConversationKeepOpen: (id, keepOpen) => {
      void caps.tabs.setKeepOpen(id, keepOpen);
    },
    jobsPanelOpened: openJobsPanel,
    jobsPanelClosed: (panelId) => caps.jobsBridge()?.closePanel(panelId),
    openJob: (panelId, id) => void caps.jobsBridge()?.clickJob(panelId, id),
    // The bridge validates the request itself: a bad generation, tab or needle
    // is refused there and answered to the panel that sent it, so this switch
    // stays the one-line hand-off its header promises.
    sessionSearchQuery: (query) => caps.sessionSearch?.()?.search(query),
    sessionSearchClosed: (panelId) => caps.sessionSearch?.()?.closePanel(panelId),
    // `null` is a reset: the key is deleted, so the default size returns. The
    // store itself is `HistoryPanelSize.ts`'s, including its Zod bounds check.
    historyPanelSize: (size) => storeHistoryPanelSize(caps.globalState(), size),
  };
}
