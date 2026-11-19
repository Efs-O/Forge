import React, { useEffect, useMemo, useReducer, useCallback, useRef, useState } from 'react';
import { splitModelProfile } from '../../src/config/ConfigResolver';
import type { HostToWebview, JobPanelMeta } from '../../src/sidebar/messageBridge';
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
  selectClankerActive,
} from './reducer';
export type { AppMessage } from './reducer';
import { Header, type WorkspaceInfo } from './components/Header';
import { TranscriptPanes } from './components/TranscriptPanes';
import { CheckpointBar } from './components/CheckpointBar';
import { InputRow } from './components/InputRow';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { QuestionDialog } from './components/QuestionDialog';
import { selectVisibleQuestion, useAgentDialogs } from './useAgentDialogs';
import { ChatHeader } from './components/ChatHeader';
import { HistoryList } from './components/HistoryList';
import { EmptyState } from './components/EmptyState';
import { resumedTabIds } from './resumedTabs';
import { StreamingStatus } from './components/StreamingStatus';
import { SLASH_COMMANDS } from './slashCommands';
import { useComposerSend } from './composerSend';
import { webviewDiagnostics } from './WebviewDiagnostics';
import { useHostCommands } from './hostCommands';
import { usePendingPrompts } from './usePendingPrompts';
import { hostMessageToAction, hostUserPromptToAction } from './hostActions';
import {
  reportDraftBearingConversationIds,
  setConversationKeepOpen,
} from './sessionRetentionMessages';
export type { QueuedPrompt } from './usePendingPrompts';

type WorkspaceContextInfo = WorkspaceInfo & { screenshotsUri?: string };

export function App(): React.ReactElement {
  webviewDiagnostics.recordRender();
  const [state, dispatch] = useReducer(reducer, initialState);
  const openConversationIds = useMemo(() => new Set(state.tabs.map((tab) => tab.id)), [state.tabs]);

  // A tool approval and an ask_user question: two dialogs with one shared rule,
  // which is why they live together. See useAgentDialogs.
  const dialogs = useAgentDialogs(state.activeConversationId);
  const visibleQuestion = selectVisibleQuestion(
    dialogs.questions.values(),
    state.activeConversationId,
  );
  const [tokenUsed, setTokenUsed] = useState(0);
  const [tokenMax, setTokenMax] = useState(0);
  const [compactAt, setCompactAt] = useState<number | undefined>(undefined);
  const [workspace, setWorkspace] = useState<WorkspaceContextInfo | undefined>(undefined);
  const [prefillText, setPrefillText] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  // The Jobs section's snapshot, and the generation of the panel it belongs to.
  // `jobsPanelId.current` is the generation the host is answering (0 once the
  // panel has closed), so a snapshot or a navigation acknowledgement for a panel
  // that closed — or was replaced by a reopen — cannot act on this one.
  const [jobs, setJobs] = useState<JobPanelMeta[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const jobsPanelId = useRef(0);
  const jobsSeq = useRef(0);
  // The same generation, as state, so the panel can scope its content search to
  // the panel the host is answering. A ref cannot be read by a component that
  // only re-renders on sync, so this mirrors it rather than replacing it.
  const [panelId, setPanelId] = useState(0);
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
      if (msg.type === 'userPrompt') {
        const promptAction = hostUserPromptToAction(msg);
        if (!promptAction) return;
        if (msg.midTurn) {
          // Retire the matching queued chip; the bubble below replaces it.
          reconcileSessionSync({
            [msg.conversationId]: [
              {
                role: 'user',
                content: msg.text,
                midTurn: true,
                ...(msg.createdAt !== undefined ? { createdAt: msg.createdAt } : {}),
              },
            ],
          });
        } else {
          // A prompt sent from a paired chat or VS Code command.
          clearTellPrompts(msg.conversationId);
        }
        dispatch(promptAction);
        return;
      }
      const action = hostMessageToAction(msg);
      if (action) {
        dispatch(action);
        return;
      }
      switch (msg.type) {
        case 'workspaceInfo':
          setWorkspace({
            name: msg.name,
            path: msg.path,
            extraRoots: msg.extraRoots,
            stale: msg.stale,
            ...(msg.rootUri ? { rootUri: msg.rootUri } : {}),
            ...(msg.screenshotsUri ? { screenshotsUri: msg.screenshotsUri } : {}),
            ...(msg.forgeIconUri ? { forgeIconUri: msg.forgeIconUri } : {}),
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
          setCompactAt(msg.compactAt);
          break;
        case 'setInput':
          clearTellPrompts(msg.conversationId);
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
    handleRunSlashCommand,
    handleResetApprovals,
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

  // The Jobs section is panel-scoped: opening it asks the host for the store,
  // closing it tells the host to stop pushing and release what it opened. The
  // generation number goes with both, so the host can tell this panel from the
  // one that came before it — and a window reload, which restarts the count on
  // a brand-new webview, cannot be mistaken for the old panel still open.
  useEffect(() => {
    if (!historyExpanded) return;
    const panelId = ++jobsSeq.current;
    jobsPanelId.current = panelId;
    setJobs([]);
    setJobsLoaded(false);
    setPanelId(panelId);
    vscode.postMessage({ type: 'jobsPanelOpened', panelId });
    return () => {
      if (jobsPanelId.current !== panelId) return;
      jobsPanelId.current = 0;
      // 0 says there is no open panel: the search box stops asking, and a reply
      // still on its way cannot be applied to a panel that has closed.
      setPanelId(0);
      vscode.postMessage({ type: 'jobsPanelClosed', panelId });
    };
  }, [historyExpanded]);

  // The host's two jobs replies get their own listener: they address the panel
  // this window has open rather than the transcript, and `jobOpened` is the
  // host confirming the navigation worked. Only then does the panel dismiss — a
  // deleted job or a refused discuss leaves it visible with the host's error.
  useEffect(() => {
    function handler(event: MessageEvent): void {
      const msg = event.data as HostToWebview;
      if (msg.type !== 'jobsSnapshot' && msg.type !== 'jobOpened') return;
      if (msg.panelId !== jobsPanelId.current) return;
      if (msg.type === 'jobsSnapshot') {
        setJobs(msg.jobs);
        setJobsLoaded(true);
      } else collapseHistory();
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [collapseHistory]);

  // A window with no conversations at all still has a reason to open the panel:
  // its jobs. Collapse only once the host has answered that there are no jobs
  // either — collapsing on the still-empty list before the snapshot lands would
  // close the panel milliseconds after it opened.
  useEffect(() => {
    if (
      state.history.length === 0 &&
      (state.archived?.length ?? 0) === 0 &&
      state.tabs.length === 0 &&
      jobsLoaded &&
      jobs.length === 0
    ) {
      setHistoryExpanded(false);
    }
  }, [state.archived?.length, state.history.length, state.tabs.length, jobs.length, jobsLoaded]);

  // A job row is a navigation, not a chat switch: the host resolves the id
  // against the store again before it touches any conversation.
  const handleOpenJob = useCallback((id: string) => {
    vscode.postMessage({ type: 'openJob', panelId: jobsPanelId.current, id });
  }, []);
  // What the send button does with the text, including the command it refuses
  // instead of spending a turn on it (`composerSend.ts`).
  const handleComposerSend = useComposerSend({
    dispatch,
    handleSend,
    restoreDraft: setPrefillText,
  });
  const handleUnlinkAgent = useCallback(
    (agentKind: import('../../src/agentLinks/chatAgentLinks').AgentKind) =>
      vscode.postMessage({ type: 'runSlashCommand', commandId: 'unlinkAgent', agentKind }),
    [],
  );
  const handlePrefillConsumed = useCallback(() => setPrefillText(null), []);

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
        <Header
          tokenUsed={tokenUsed}
          tokenMax={tokenMax}
          compactAt={compactAt}
          workspace={workspace}
        />
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
                messagedChats={
                  state.tabs.find((tab) => tab.id === state.activeConversationId)?.messagedChats
                }
                onUnlinkAgent={handleUnlinkAgent}
                onOpenChat={handleSwitchFromPanel}
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
                onResetApprovals={handleResetApprovals}
                onClose={handleCloseTab}
                onSetKeepOpen={setConversationKeepOpen}
                onSwitchOpen={handleSwitchFromPanel}
                jobs={jobs}
                jobsLoaded={jobsLoaded}
                panelId={panelId}
                onOpenJob={handleOpenJob}
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
          clanker={selectClankerActive(state)}
          waiting={Boolean(visibleQuestion || dialogs.confirmRequest)}
        />
        <CheckpointBar visible={selectCheckpointPending(state)} stats={checkpointStats} />
        <div id="composer-area">
          <div
            className="composer-slot"
            hidden={Boolean(visibleQuestion || dialogs.confirmRequest)}
          >
            <InputRow
              onSend={handleComposerSend}
              onCancel={handleCancel}
              streaming={streaming}
              backendReady={state.backendReady}
              slashCommands={SLASH_COMMANDS}
              onRunSlashCommand={handleRunSlashCommand}
              prefillText={prefillText}
              onPrefillConsumed={handlePrefillConsumed}
              clankerMode={selectClankerActive(state)}
              models={state.models}
              activeModel={state.activeModel}
              onModelChange={handleModelChange}
              modelPickerDisabled={uiBusy}
              remote={state.remote}
              activeConversationId={state.activeConversationId}
              retentionReady={state.sessionHydrated}
              openConversationIds={openConversationIds}
              onDraftBearingConversationIds={reportDraftBearingConversationIds}
            />
          </div>
          {/* Confirmation was rendered after a question before docking, so it
              remains the active panel when both requests are pending. The
              question stays in dialog state and appears when approval settles. */}
          {dialogs.confirmRequest ? (
            <ConfirmationDialog
              toolName={dialogs.confirmRequest.toolName}
              detail={dialogs.confirmRequest.detail}
              cardReason={dialogs.confirmRequest.cardReason}
              isDangerous={dialogs.confirmRequest.isDangerous}
              allowForChat={dialogs.confirmRequest.allowForChat}
              alwaysInProject={dialogs.confirmRequest.alwaysInProject}
              onApprove={dialogs.approveConfirm}
              onAllowForChat={dialogs.allowConfirmForChat}
              onAlwaysInProject={dialogs.alwaysConfirmInProject}
              onDeny={dialogs.denyConfirm}
            />
          ) : visibleQuestion ? (
            <QuestionDialog
              key={visibleQuestion.id}
              question={visibleQuestion}
              draft={dialogs.drafts.get(visibleQuestion.id)!}
              autoFocus={visibleQuestion.focusOnOpen}
              onDraftChange={(draft) => dialogs.updateQuestionDraft(visibleQuestion.id, draft)}
              onAnswer={(answer) => dialogs.answerQuestion(visibleQuestion.id, answer)}
              onSkip={() => dialogs.skipQuestion(visibleQuestion.id)}
            />
          ) : null}
        </div>
      </div>
    </WorkspaceUrisProvider>
  );
}
