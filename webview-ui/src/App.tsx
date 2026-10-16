import React, { useEffect, useMemo, useReducer, useCallback, useRef, useState } from 'react';
import { splitModelProfile } from '../../src/config/ConfigResolver';
import type {
  ForgeSlashCommandId,
  HostToWebview,
  SessionHistoryMeta,
  SessionTabMeta,
} from '../../src/sidebar/messageBridge';
import { vscode } from './vscode';
import { WorkspaceUrisProvider } from './workspaceRootUri';
import {
  reducer,
  initialState,
  selectMessages,
  selectStreaming,
  selectGenerating,
  selectCheckpointPending,
  selectCheckpointStats,
} from './reducer';
export type { AppMessage } from './reducer';
import { Header, type WorkspaceInfo } from './components/Header';
import { TranscriptPanes } from './components/TranscriptPanes';
import { CheckpointBar } from './components/CheckpointBar';
import { InputRow } from './components/InputRow';
import { toMessageAttachments } from './components/useAttachments';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { QuestionDialog } from './components/QuestionDialog';
import { useAgentDialogs } from './useAgentDialogs';
import { ChatHeader } from './components/ChatHeader';
import { HistoryList } from './components/HistoryList';
import { EmptyState } from './components/EmptyState';
import { resumedTabIds } from './resumedTabs';
import { StreamingStatus } from './components/StreamingStatus';
import { SLASH_COMMANDS } from './slashCommands';
import { webviewDiagnostics } from './WebviewDiagnostics';
import { useHostCommands } from './hostCommands';
import { usePendingPrompts } from './usePendingPrompts';
import { hostMessageToAction } from './hostActions';
export type { QueuedPrompt } from './usePendingPrompts';

type WorkspaceContextInfo = WorkspaceInfo & { screenshotsUri?: string };

export function App(): React.ReactElement {
  webviewDiagnostics.recordRender();
  const [state, dispatch] = useReducer(reducer, initialState);

  // A tool approval and an ask_user question: two modals with one shared rule,
  // which is why they live together. See useAgentDialogs.
  const dialogs = useAgentDialogs();
  const [tokenUsed, setTokenUsed] = useState(0);
  const [tokenMax, setTokenMax] = useState(0);
  const [workspace, setWorkspace] = useState<WorkspaceContextInfo | undefined>(undefined);
  const [prefillText, setPrefillText] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [waitingIds, setWaitingIds] = useState<ReadonlySet<string>>(() => new Set());
  // Conversations restored from an earlier window session, snapshotted once at
  // hydration. State rather than a ref: the snapshot lands after the first
  // render and must schedule another one.
  const [resumedIds, setResumedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const resumedCaptured = useRef(false);

  /** Sending in a tab settles it: the marker never returns for that tab. */
  const clearResumed = useCallback((convId: string) => {
    setResumedIds((current) => {
      if (!current.has(convId)) return current;
      const next = new Set(current);
      next.delete(convId);
      return next;
    });
  }, []);
  // Queued prompts belong in state so the user can see and cancel them before
  // Forge submits them to the extension host. Text-only entries become tells;
  // attachment entries retain the end-of-turn queue.
  const {
    queuedPrompts,
    handleSend,
    cancelQueuedPrompt,
    sendQueuedPromptNow,
    clearTellPrompts,
    reconcileSessionSync,
  } = usePendingPrompts({
    dispatch,
    activeConversationId: state.activeConversationId,
    streamingIds: state.streamingIds,
    clearResumed,
  });
  useEffect(() => {
    function handler(event: MessageEvent): void {
      const msg = event.data as HostToWebview;
      webviewDiagnostics.recordHostMessage(msg);
      // Consumes the approval/question messages and reports that it did, so the
      // switch below never has to know they exist.
      if (dialogs.handleHostMessage(msg)) return;
      const action = hostMessageToAction(msg);
      if (action) {
        dispatch(action);
        return;
      }
      switch (msg.type) {
        case 'userPrompt':
          if (msg.midTurn) {
            // Retire the matching queued chip: the bubble below replaces it.
            if (msg.conversationId) {
              reconcileSessionSync({
                [msg.conversationId]: [{ role: 'user', content: msg.text, midTurn: true }],
              });
            }
            dispatch({ type: 'MID_TURN_TELL', text: msg.text, convId: msg.conversationId });
            break;
          }
          // A prompt sent from a paired chat or a VS Code command. Reuses
          // USER_SEND rather than adding a reducer case, so a remote prompt
          // performs the same stale-diff and stale-error stripping a typed one
          // does -- the bubble is identical because the action is.
          clearTellPrompts(msg.conversationId);
          dispatch({
            type: 'USER_SEND',
            text: msg.text,
            convId: msg.conversationId,
            ...(msg.sender ? { sender: msg.sender } : {}),
            ...(msg.attachments?.length
              ? { attachments: toMessageAttachments(msg.attachments) }
              : {}),
          });
          break;
        case 'workspaceInfo':
          setWorkspace({
            name: msg.name,
            path: msg.path,
            extraRoots: msg.extraRoots,
            stale: msg.stale,
            ...(msg.rootUri ? { rootUri: msg.rootUri } : {}),
            ...(msg.screenshotsUri ? { screenshotsUri: msg.screenshotsUri } : {}),
          });
          break;
        case 'sessionSync':
          setWaitingIds(new Set(msg.waitingIds));
          reconcileSessionSync(msg.messagesById);
          dispatch({
            type: 'SESSION_SYNC',
            activeId: msg.activeId,
            tabs: msg.tabs,
            history: msg.history,
            archived: msg.archived,
            messagesById: msg.messagesById,
            attachmentsRoot: msg.attachmentsRoot,
          });
          break;
        case 'tokenBudget':
          setTokenUsed(msg.used);
          setTokenMax(msg.max);
          break;
        case 'setInput':
          clearTellPrompts(msg.conversationId);
          setPrefillText(msg.text);
          break;
        case 'thread-stream-state-changed':
        case 'thread-read-state-changed':
        case 'historyRestore':
        case 'newChat':
          break;
      }
    }
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'webviewReady' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // One-shot: the first hydrated sync decides which tabs read as resumed.
  useEffect(() => {
    if (resumedCaptured.current || !state.sessionHydrated) return;
    resumedCaptured.current = true;
    setResumedIds(resumedTabIds(state.tabs, Date.now()));
  }, [state.sessionHydrated, state.tabs]);

  const {
    handleCancel,
    handleModelChange,
    handleNewConversation,
    handleSwitchTab,
    handleCloseTab,
    handleRestoreConversation,
    handleDeleteConversation,
    handleRenameConversation,
  } = useHostCommands(dispatch);

  // Picking a session from the panel is a navigation, so the panel dismisses
  // itself — left open it hides the very conversation just selected behind the
  // list it was selected from. Only the two selecting actions collapse it:
  // rename and delete are management, and walking down the list should survive
  // them. The handlers live here rather than in HistoryList so the panel never
  // owns its own dismissal.
  const refocusToggle = useRef(false);
  useEffect(() => {
    if (historyExpanded || !refocusToggle.current) return;
    refocusToggle.current = false;
    // The row that had focus is hidden along with the panel; without this,
    // focus falls to <body> and keyboard users lose their place.
    document.getElementById('history-toolbar-btn')?.focus();
  }, [historyExpanded]);
  const collapseHistory = useCallback(() => {
    refocusToggle.current = true;
    setHistoryExpanded(false);
  }, []);
  const handleRestoreFromPanel = useCallback(
    (id: string) => {
      handleRestoreConversation(id);
      collapseHistory();
    },
    [handleRestoreConversation, collapseHistory],
  );
  const handleSwitchFromPanel = useCallback(
    (id: string) => {
      handleSwitchTab(id);
      collapseHistory();
    },
    [handleSwitchTab, collapseHistory],
  );

  useEffect(() => {
    if (
      state.history.length === 0 &&
      (state.archived?.length ?? 0) === 0 &&
      state.tabs.length === 0
    ) {
      setHistoryExpanded(false);
    }
  }, [state.archived?.length, state.history.length, state.tabs.length]);

  const handleRunSlashCommand = useCallback((commandId: ForgeSlashCommandId) => {
    vscode.postMessage({ type: 'runSlashCommand', commandId });
  }, []);
  const handleComposerSend = useCallback(
    (text: string, attachments: Parameters<typeof handleSend>[1]) => {
      const trimmed = text.trim();
      if (/^\/link(?:\s|$)/u.test(trimmed)) {
        const words = trimmed.split(/\s+/u).slice(1);
        vscode.postMessage({
          type: 'runSlashCommand',
          commandId: 'linkAgent',
          ...(words[0] ? { agentKind: words[0] } : {}),
          ...(words.length > 1 ? { sessionId: words.slice(1).join(' ') } : {}),
        });
        return;
      }
      handleSend(text, attachments);
    },
    [handleSend],
  );
  const handleLinkAgent = useCallback(
    () => handleRunSlashCommand('linkAgent'),
    [handleRunSlashCommand],
  );
  const handleUnlinkAgent = useCallback(
    (agentKind: import('../../src/agentLinks/chatAgentLinks').AgentKind) =>
      vscode.postMessage({ type: 'runSlashCommand', commandId: 'unlinkAgent', agentKind }),
    [],
  );
  const handlePrefillConsumed = useCallback(() => setPrefillText(null), []);

  // Unused tab/history types satisfy TS — keep them aligned with SessionSyncMsg shape
  void ([] as SessionTabMeta[]);
  void ([] as SessionHistoryMeta[]);

  const messages = selectMessages(state);
  const streaming = selectStreaming(state);
  const generating = selectGenerating(state);
  const uiBusy = generating;
  // `residency` is sent only for models Forge itself hosts, so its presence is
  // the local/remote answer already — no second heuristic to drift from it.
  const activeBaseModel = state.activeModel ? splitModelProfile(state.activeModel).base : undefined;
  const activeModelEntry = state.models.find((model) => model.name === activeBaseModel);
  const activeModelIsLocal = activeModelEntry?.residency !== undefined;

  const queuedIds = useMemo(
    () =>
      new Set(
        queuedPrompts.filter((prompt) => !prompt.tell).map((prompt) => prompt.conversationId),
      ),
    [queuedPrompts],
  );

  useEffect(() => {
    vscode.postMessage({ type: 'queuedConversationIds', ids: [...queuedIds] });
  }, [queuedIds]);

  const emptyState = useMemo(
    () => (
      <EmptyState
        modelName={state.activeModel}
        residency={activeModelEntry?.residency}
        provider={activeModelEntry?.provider}
        contextMax={tokenMax}
      />
    ),
    [state.activeModel, activeModelEntry?.residency, activeModelEntry?.provider, tokenMax],
  );

  useEffect(() => {
    webviewDiagnostics.recordState({
      activeConversationId: state.activeConversationId,
      displayedMessages: messages.length,
      queuedPrompts: queuedPrompts.length,
      streaming,
      prefillPending: prefillText !== null,
    });
  }, [messages.length, prefillText, queuedPrompts.length, state.activeConversationId, streaming]);

  const checkpointStats = selectCheckpointStats(state);

  return (
    <WorkspaceUrisProvider rootUri={workspace?.rootUri} screenshotsUri={workspace?.screenshotsUri}>
      <div id="forge-root">
        <Header tokenUsed={tokenUsed} tokenMax={tokenMax} workspace={workspace} />
        <aside id="chats-panel" aria-label="Forge sessions">
          {!state.sessionHydrated && (
            <span id="chats-loading" role="status">
              Loading…
            </span>
          )}
          {state.sessionHydrated && (
            <>
              <ChatHeader
                // Remounting on a chat switch drops a half-typed rename of the previous chat.
                key={state.activeConversationId}
                title={
                  state.tabs.find((tab) => tab.id === state.activeConversationId)?.title ?? 'Chat'
                }
                historyExpanded={historyExpanded}
                agentLinks={
                  state.tabs.find((tab) => tab.id === state.activeConversationId)?.agentLinks
                }
                onLinkAgent={handleLinkAgent}
                onUnlinkAgent={handleUnlinkAgent}
                onNew={handleNewConversation}
                onToggleHistory={() => setHistoryExpanded((expanded) => !expanded)}
                onRename={
                  state.activeConversationId
                    ? (title) => handleRenameConversation(state.activeConversationId, title)
                    : undefined
                }
              />
              <HistoryList
                items={state.history}
                archived={state.archived}
                openItems={[...state.tabs].sort((a, b) => b.updatedAt - a.updatedAt)}
                activeId={state.activeConversationId}
                streamingIds={state.streamingIds}
                queuedIds={queuedIds}
                waitingIds={waitingIds}
                expanded={historyExpanded}
                onDismiss={collapseHistory}
                onRestore={handleRestoreFromPanel}
                onDelete={handleDeleteConversation}
                onRename={handleRenameConversation}
                onClose={handleCloseTab}
                onSwitchOpen={handleSwitchFromPanel}
              />
            </>
          )}
        </aside>
        <TranscriptPanes
          state={state}
          queuedPrompts={queuedPrompts}
          onCancelQueuedPrompt={cancelQueuedPrompt}
          onSendQueuedPromptNow={sendQueuedPromptNow}
          resumedIds={resumedIds}
          emptyState={emptyState}
        />
        <StreamingStatus
          streaming={streaming}
          local={activeModelIsLocal}
          clanker={state.clankerMode}
        />
        <CheckpointBar visible={selectCheckpointPending(state)} stats={checkpointStats} />
        <InputRow
          onSend={handleComposerSend}
          onCancel={handleCancel}
          streaming={streaming}
          backendReady={state.backendReady}
          slashCommands={SLASH_COMMANDS}
          onRunSlashCommand={handleRunSlashCommand}
          prefillText={prefillText}
          onPrefillConsumed={handlePrefillConsumed}
          clankerMode={state.clankerMode}
          models={state.models}
          activeModel={state.activeModel}
          onModelChange={handleModelChange}
          modelPickerDisabled={uiBusy}
          remote={state.remote}
          activeConversationId={state.activeConversationId}
        />
        {dialogs.question && (
          <QuestionDialog
            prompt={dialogs.question.prompt}
            placeholder={dialogs.question.placeholder}
            options={dialogs.question.options}
            questions={dialogs.question.questions}
            onAnswer={dialogs.answerQuestion}
            onDismiss={dialogs.dismissQuestion}
          />
        )}
        {dialogs.confirmRequest && (
          <ConfirmationDialog
            toolName={dialogs.confirmRequest.toolName}
            detail={dialogs.confirmRequest.detail}
            isDangerous={dialogs.confirmRequest.isDangerous}
            onApprove={dialogs.approveConfirm}
            onDeny={dialogs.denyConfirm}
          />
        )}
      </div>
    </WorkspaceUrisProvider>
  );
}
