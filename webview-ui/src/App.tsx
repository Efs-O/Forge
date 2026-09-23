import React, { useEffect, useMemo, useReducer, useCallback, useRef, useState } from 'react';
import { splitModelProfile } from '../../src/config/ConfigResolver';
import type {
  ForgeSlashCommandId,
  HostToWebview,
  SessionHistoryMeta,
  SessionTabMeta,
} from '../../src/sidebar/messageBridge';
import { vscode } from './vscode';
import { WorkspaceRootUriContext } from './workspaceRootUri';
import {
  reducer,
  initialState,
  selectMessages,
  selectStreaming,
  selectGenerating,
  selectCheckpointPending,
} from './reducer';
export type { AppMessage } from './reducer';
import { Header, type WorkspaceInfo } from './components/Header';
import { TranscriptPanes } from './components/TranscriptPanes';
import { CheckpointBar } from './components/CheckpointBar';
import { diffStats } from './components/DiffBlock';
import { InputRow } from './components/InputRow';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { QuestionDialog } from './components/QuestionDialog';
import { useAgentDialogs } from './useAgentDialogs';
import { TabStrip } from './components/TabStrip';
import { HistoryList } from './components/HistoryList';
import { EmptyState } from './components/EmptyState';
import { resumedTabIds } from './resumedTabs';
import { StreamingStatus } from './components/StreamingStatus';
import { SLASH_COMMANDS } from './slashCommands';
import { webviewDiagnostics } from './WebviewDiagnostics';
import { useHostCommands } from './hostCommands';
import { usePendingPrompts } from './usePendingPrompts';
export type { QueuedPrompt } from './usePendingPrompts';

export function App(): React.ReactElement {
  webviewDiagnostics.recordRender();
  const [state, dispatch] = useReducer(reducer, initialState);

  // A tool approval and an ask_user question: two modals with one shared rule,
  // which is why they live together. See useAgentDialogs.
  const dialogs = useAgentDialogs();
  const [tokenUsed, setTokenUsed] = useState(0);
  const [tokenMax, setTokenMax] = useState(0);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | undefined>(undefined);
  const [prefillText, setPrefillText] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
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
  const { queuedPrompts, handleSend, cancelQueuedPrompt, clearTellPrompts, reconcileSessionSync } =
    usePendingPrompts({
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
      switch (msg.type) {
        case 'generationStarted':
          dispatch({ type: 'GENERATION_STARTED', convId: msg.conversationId });
          break;
        case 'userPrompt':
          // A prompt sent from a paired chat or a VS Code command. Reuses
          // USER_SEND rather than adding a reducer case, so a remote prompt
          // performs the same stale-diff and stale-error stripping a typed one
          // does -- the bubble is identical because the action is.
          clearTellPrompts(msg.conversationId);
          dispatch({ type: 'USER_SEND', text: msg.text, convId: msg.conversationId });
          break;
        case 'token':
          dispatch({ type: 'TOKEN', text: msg.text, convId: msg.conversationId });
          break;
        case 'notice':
          dispatch({
            type: 'NOTICE',
            message: msg.message,
            convId: msg.conversationId,
            preformatted: msg.preformatted,
          });
          break;
        case 'reasoningToken':
          dispatch({ type: 'REASONING_TOKEN', text: msg.text, convId: msg.conversationId });
          break;
        case 'done':
          dispatch({ type: 'DONE', convId: msg.conversationId });
          break;
        case 'error':
          dispatch({ type: 'ERROR', message: msg.message, convId: msg.conversationId });
          break;
        case 'ready':
          dispatch({ type: 'READY', convId: msg.conversationId });
          break;
        case 'workspaceInfo':
          setWorkspace({
            name: msg.name,
            path: msg.path,
            extraRoots: msg.extraRoots,
            stale: msg.stale,
            ...(msg.rootUri ? { rootUri: msg.rootUri } : {}),
          });
          break;
        case 'backendStarting':
          dispatch({ type: 'BACKEND_STARTING', message: msg.message, convId: msg.conversationId });
          break;
        case 'backendDown':
          dispatch({ type: 'BACKEND_DOWN', message: msg.message, convId: msg.conversationId });
          break;
        case 'models':
          dispatch({ type: 'MODELS', models: msg.models, active: msg.active });
          break;
        case 'checkpointReady':
          dispatch({ type: 'CHECKPOINT_READY', convId: msg.conversationId });
          break;
        case 'checkpointDismissed':
          dispatch({ type: 'CHECKPOINT_DISMISSED', convId: msg.conversationId });
          break;
        case 'toolActivity':
          dispatch({
            type: 'TOOL_ACTIVITY',
            toolName: msg.toolName,
            toolCallId: msg.toolCallId,
            detail: msg.detail,
            convId: msg.conversationId,
          });
          break;
        case 'toolResult':
          dispatch({
            type: 'TOOL_RESULT',
            toolName: msg.toolName,
            toolCallId: msg.toolCallId,
            label: msg.label,
            text: msg.text,
            totalChars: msg.totalChars,
            ...(msg.filePath ? { filePath: msg.filePath } : {}),
            ...(msg.isError ? { isError: true } : {}),
            convId: msg.conversationId,
          });
          break;
        case 'fileDiff':
          dispatch({
            type: 'FILE_DIFF',
            filePath: msg.filePath,
            hunks: msg.hunks,
            isNew: msg.isNew,
            isDeleted: msg.isDeleted,
            convId: msg.conversationId,
          });
          break;
        case 'sessionSync':
          reconcileSessionSync(msg.messagesById);
          dispatch({
            type: 'SESSION_SYNC',
            activeId: msg.activeId,
            tabs: msg.tabs,
            history: msg.history,
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
        case 'clankerChanged':
          dispatch({ type: 'CLANKER_CHANGED', enabled: msg.enabled });
          break;
        case 'remoteStatus':
          dispatch({ type: 'REMOTE_STATUS', transports: msg.transports, paired: msg.paired });
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

  // The panel lists closed sessions only - open tabs are the strip's job - so an
  // empty history is once again an empty panel. Restoring or deleting the last
  // closed chat while it is open would otherwise leave an empty overlay
  // covering the transcript.
  useEffect(() => {
    if (state.history.length === 0) setHistoryExpanded(false);
  }, [state.history.length]);

  const handleRunSlashCommand = useCallback((commandId: ForgeSlashCommandId) => {
    vscode.postMessage({ type: 'runSlashCommand', commandId });
  }, []);
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

  // The bar reports the same edits the transcript's diff card shows.
  const checkpointStats = useMemo(() => {
    const diffs = messages.filter((m) => m.role === 'diff');
    return diffs.reduce(
      (acc, msg) => {
        const { added, removed } = diffStats(msg.diffHunks);
        return {
          fileCount: acc.fileCount + 1,
          added: acc.added + added,
          removed: acc.removed + removed,
        };
      },
      { fileCount: 0, added: 0, removed: 0 },
    );
  }, [messages]);

  return (
    <WorkspaceRootUriContext.Provider value={workspace?.rootUri}>
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
              <TabStrip
                tabs={state.tabs}
                activeId={state.activeConversationId}
                streamingIds={state.streamingIds}
                queuedIds={queuedIds}
                historyExpanded={historyExpanded}
                onSwitch={handleSwitchTab}
                onNew={handleNewConversation}
                onClose={handleCloseTab}
                onToggleHistory={() => setHistoryExpanded((expanded) => !expanded)}
              />
              <HistoryList
                items={state.history}
                expanded={historyExpanded}
                onDismiss={collapseHistory}
                onRestore={handleRestoreFromPanel}
                onDelete={handleDeleteConversation}
                onRename={handleRenameConversation}
              />
            </>
          )}
        </aside>
        <TranscriptPanes
          state={state}
          queuedPrompts={queuedPrompts}
          onCancelQueuedPrompt={cancelQueuedPrompt}
          resumedIds={resumedIds}
          emptyState={emptyState}
        />
        <StreamingStatus
          streaming={streaming}
          local={activeModelIsLocal}
          clanker={state.clankerMode}
        />
        <CheckpointBar
          visible={selectCheckpointPending(state)}
          fileCount={checkpointStats.fileCount}
          added={checkpointStats.added}
          removed={checkpointStats.removed}
        />
        <InputRow
          onSend={handleSend}
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
    </WorkspaceRootUriContext.Provider>
  );
}
