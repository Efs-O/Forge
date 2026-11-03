/**
 * Routes one webview message to the host action it names.
 *
 * Split out of `SidebarProvider`, which now only supplies the actions. Keeping
 * the switch here means the provider is not also the transport: every case is a
 * one-line hand-off, and the discriminated union in `messageBridge` stays the
 * single description of what the webview can ask for.
 */

import type {
  ForgeSlashCommandId,
  HostToWebview,
  HistoryPanelSize,
  SessionSearchQueryMsg,
  WebviewDiagnosticMsg,
  WebviewToHost,
} from './messageBridge';
import type { AttachmentData } from './messageBridge';
import type { StructuredAnswer } from '../util/questionAnswers';
import { buildApprovalRequestMessage, type ToolApprovalRequestEvent } from './ToolApprovalService';
import { buildQuestionMessage } from './sidebarPayloads';
import type { UserQuestionRequestEvent } from './UserQuestionService';

export interface WebviewActions {
  post: (msg: HostToWebview) => void;
  postModels: () => void;
  postSessionSync: () => void;
  postActivityView: () => string | undefined;
  postTokenBudget: () => void;
  postWorkspaceInfo: () => void;
  isBackendReady: () => boolean;
  /** Every chat this window can reach, with its own Clanker state — a reloaded
   *  webview has no flags, and Clanker is armed one chat at a time.
   */
  getClankerStates: () => Array<{ conversationId: string; enabled: boolean }>;
  getRemoteStatus: () => { transports: string[]; paired: boolean };
  pendingQuestions: () => UserQuestionRequestEvent[];
  pendingApproval: () => ToolApprovalRequestEvent | undefined;
  send: (
    text: string,
    attachments?: AttachmentData[],
    conversationId?: string,
    tellId?: string,
    createdAt?: number,
  ) => void;
  /** False when the tell had already reached the running turn. */
  cancelTell: (conversationId: string, tellId: string) => boolean;
  /** False when the tell had already reached the running turn. */
  sendQueuedNow: (conversationId: string, tellId?: string) => boolean;
  cancel: () => void;
  switchModel: (name: string | null) => Promise<void>;
  undo: () => Promise<string[]>;
  keep: () => Promise<void>;
  reviewCheckpoint: () => Promise<void>;
  newConversation: () => void;
  switchConversation: (id: string) => void;
  closeConversation: (id: string) => void;
  restoreConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  resetApprovals: (conversationId: string) => void;
  runSlashCommand: (
    id: ForgeSlashCommandId,
    agent?: { agentKind?: string; sessionId?: string; approvalAction?: 'reset' | 'invalid' },
  ) => void;
  openFile: (path: string, line?: number, beside?: boolean) => Promise<void>;
  openAttachment: (relativePath: string) => Promise<void>;
  resolveConfirmation: (
    id: string,
    decision: import('./approvalMessages').ApprovalDecision,
  ) => void;
  answerQuestion: (id: string, answer: StructuredAnswer) => void;
  skipQuestion: (id: string) => void;
  recordWebviewDiagnostic: (message: WebviewDiagnosticMsg) => void;
  queuedConversationIds: (ids: string[]) => void;
  draftBearingConversationIds: (ids: string[]) => void;
  setConversationKeepOpen: (id: string, keepOpen: boolean) => void;
  /** The sessions panel's Jobs section opened, carrying its panel generation. */
  jobsPanelOpened: (panelId: number) => void;
  jobsPanelClosed: (panelId: number) => void;
  /** A job row was clicked; the host navigates and answers with `jobOpened`. */
  openJob: (panelId: number, id: string) => void;
  /**
   * The search box changed on a chat tab: the host walks the saved transcripts
   * and publishes what it reaches. The message is validated inside the bridge,
   * keeping this switch a one-line hand-off like every other case.
   */
  sessionSearchQuery: (query: SessionSearchQueryMsg) => void;
  /**
   * The panel closed. `jobsPanelClosed` is the panel's close, not the Jobs
   * tab's, so it releases the content-search scan as well as the store push —
   * otherwise a scan started a moment before the close would keep reading
   * hundreds of archived chats for a panel nobody is looking at.
   */
  sessionSearchClosed: (panelId: number) => void;
  /** The panel was dragged, keyed or reset: remember the size, or forget it. */
  historyPanelSize: (size: HistoryPanelSize | null) => void;
}

export function routeWebviewMessage(actions: WebviewActions, msg: WebviewToHost): void {
  const reportError = (err: Error): void => actions.post({ type: 'error', message: err.message });

  switch (msg.type) {
    case 'webviewReady':
      actions.postModels();
      {
        const activityViewNotice = actions.postActivityView();
        actions.postSessionSync();
        if (activityViewNotice) actions.post({ type: 'notice', message: activityViewNotice });
      }
      // Without this the bar reads 0 until the next turn completes, and the
      // context warning cannot fire on the first turn after a window reload.
      actions.postTokenBudget();
      // Which root the tools will aim at, before the first turn rather than after.
      actions.postWorkspaceInfo();
      if (actions.isBackendReady()) actions.post({ type: 'ready' });
      // Every open chat's own state, off included: a reloaded webview starts with no
      // flags, and posting only the armed ones would leave a chat that was armed
      // before the reload showing armed after it, with nothing to clear it.
      for (const state of actions.getClankerStates()) {
        actions.post({ type: 'clankerChanged', ...state });
      }
      // The chip is host state the webview cannot derive. Without this a reload
      // shows no chip until the next transport or pairing change, which on a
      // stable setup is never.
      actions.post({ type: 'remoteStatus', ...actions.getRemoteStatus() });
      // A reloaded webview starts empty while the agent still waits on these;
      // without the re-post the turn hangs on a card nobody can see.
      for (const question of actions.pendingQuestions()) {
        actions.post(buildQuestionMessage(question));
      }
      {
        const approval = actions.pendingApproval();
        if (approval) actions.post(buildApprovalRequestMessage(approval));
      }
      break;

    case 'queuedConversationIds':
      actions.queuedConversationIds(msg.ids);
      break;

    case 'draftBearingConversationIds':
      actions.draftBearingConversationIds(msg.ids);
      break;

    case 'setConversationKeepOpen':
      actions.setConversationKeepOpen(msg.id, msg.keepOpen);
      break;

    case 'send':
      if (msg.createdAt === undefined)
        actions.send(msg.text, msg.attachments, msg.conversationId, msg.tellId);
      else actions.send(msg.text, msg.attachments, msg.conversationId, msg.tellId, msg.createdAt);
      break;

    case 'cancelTell':
      if (!actions.cancelTell(msg.conversationId, msg.tellId)) {
        actions.post({
          type: 'error',
          message: 'Forge: that message had already reached the running turn.',
        });
      }
      break;

    case 'sendQueuedNow':
      if (!actions.sendQueuedNow(msg.conversationId, msg.tellId)) {
        actions.post({
          type: 'error',
          message: 'Forge: that message had already reached the running turn.',
        });
      }
      break;

    case 'cancel':
      actions.cancel();
      break;

    case 'switchModel':
      void actions.switchModel(msg.name).catch(reportError);
      break;

    case 'undo':
      void actions
        .undo()
        .then((restored) =>
          actions.post({
            type: 'token',
            text: `\n\n> ↩ Undid last turn — restored ${restored.length} file(s).\n\n`,
          }),
        )
        .catch(reportError);
      break;

    case 'keep':
      void actions.keep().catch(reportError);
      break;

    case 'reviewCheckpoint':
      void actions.reviewCheckpoint().catch(reportError);
      break;

    case 'newChat':
    case 'newConversation':
      actions.newConversation();
      break;

    case 'switchConversation':
      actions.switchConversation(msg.id);
      break;

    case 'closeConversation':
      actions.closeConversation(msg.id);
      break;

    case 'restoreConversation':
      actions.restoreConversation(msg.id);
      break;

    case 'deleteConversation':
      actions.deleteConversation(msg.id);
      break;

    case 'renameConversation':
      actions.renameConversation(msg.id, msg.title);
      break;

    case 'resetApprovals':
      actions.resetApprovals(msg.conversationId);
      break;

    case 'runSlashCommand':
      actions.runSlashCommand(msg.commandId as ForgeSlashCommandId, msg);
      break;

    case 'openFile':
      void actions
        .openFile(msg.path, msg.line, msg.beside)
        .catch((err: Error) =>
          actions.post({ type: 'error', message: `Could not open ${msg.path}: ${err.message}` }),
        );
      break;

    case 'openAttachment':
      void actions
        .openAttachment(msg.relativePath)
        .catch((err: Error) =>
          actions.post({ type: 'error', message: `Could not open attachment: ${err.message}` }),
        );
      break;

    case 'confirmResponse':
      actions.resolveConfirmation(msg.id, msg.decision);
      break;

    case 'questionResponse':
      if (msg.kind === 'answer') actions.answerQuestion(msg.id, msg.answer);
      else actions.skipQuestion(msg.id);
      break;

    case 'webviewDiagnostic':
      actions.recordWebviewDiagnostic(msg);
      break;

    case 'jobsPanelOpened':
      actions.jobsPanelOpened(msg.panelId);
      break;

    case 'jobsPanelClosed':
      actions.jobsPanelClosed(msg.panelId);
      actions.sessionSearchClosed(msg.panelId);
      break;

    case 'sessionSearchQuery':
      actions.sessionSearchQuery(msg);
      break;

    case 'openJob':
      // The bridge reports its own failures to the panel that clicked, so a
      // deleted job or a refused discuss leaves the panel open with the reason.
      actions.openJob(msg.panelId, msg.id);
      break;

    case 'historyPanelSize':
      // One message per resize, not one per pointer move: the webview sends at
      // the end of a drag, on a grip key press, or on a reset.
      actions.historyPanelSize(msg.size);
      break;
  }
}
