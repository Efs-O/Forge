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
  WebviewDiagnosticMsg,
  WebviewToHost,
} from './messageBridge';
import type { AttachmentData } from './messageBridge';

export interface WebviewActions {
  post: (msg: HostToWebview) => void;
  postModels: () => void;
  postSessionSync: () => void;
  postTokenBudget: () => void;
  postWorkspaceInfo: () => void;
  isBackendReady: () => boolean;
  getClankerMode: () => boolean;
  send: (text: string, attachments?: AttachmentData[], conversationId?: string) => void;
  steer: (
    text: string,
    attachments: AttachmentData[] | undefined,
    conversationId: string,
  ) => Promise<void>;
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
  runSlashCommand: (id: ForgeSlashCommandId) => void;
  openFile: (path: string, line?: number, beside?: boolean) => Promise<void>;
  resolveConfirmation: (id: string, approved: boolean) => void;
  recordWebviewDiagnostic: (message: WebviewDiagnosticMsg) => void;
}

export function routeWebviewMessage(actions: WebviewActions, msg: WebviewToHost): void {
  const reportError = (err: Error): void => actions.post({ type: 'error', message: err.message });

  switch (msg.type) {
    case 'webviewReady':
      actions.postModels();
      actions.postSessionSync();
      // Without this the bar reads 0 until the next turn completes, and the
      // context warning cannot fire on the first turn after a window reload.
      actions.postTokenBudget();
      // Which root the tools will aim at, before the first turn rather than after.
      actions.postWorkspaceInfo();
      if (actions.isBackendReady()) actions.post({ type: 'ready' });
      actions.post({ type: 'clankerChanged', enabled: actions.getClankerMode() });
      break;

    case 'send':
      actions.send(msg.text, msg.attachments, msg.conversationId);
      break;

    case 'steer':
      void actions.steer(msg.text, msg.attachments, msg.conversationId).catch(reportError);
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

    case 'runSlashCommand':
      actions.runSlashCommand(msg.commandId as ForgeSlashCommandId);
      break;

    case 'openFile':
      void actions
        .openFile(msg.path, msg.line, msg.beside)
        .catch((err: Error) =>
          actions.post({ type: 'error', message: `Could not open ${msg.path}: ${err.message}` }),
        );
      break;

    case 'confirmResponse':
      actions.resolveConfirmation(msg.id, msg.approved);
      break;

    case 'webviewDiagnostic':
      actions.recordWebviewDiagnostic(msg);
      break;
  }
}
