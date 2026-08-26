import React, { useEffect, useMemo, useReducer, useCallback, useRef, useState } from 'react';
import type {
  AttachmentData,
  ForgeSlashCommandId,
  HostToWebview,
  SessionHistoryMeta,
  SessionTabMeta,
} from '../../src/sidebar/messageBridge';
import { vscode } from './vscode';
import {
  reducer,
  initialState,
  selectMessages,
  selectStreaming,
  selectGenerating,
  selectCheckpointPending,
} from './reducer';
export type { AppMessage } from './reducer';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { CheckpointBar } from './components/CheckpointBar';
import { diffStats } from './components/DiffBlock';
import { InputRow } from './components/InputRow';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { TabStrip } from './components/TabStrip';
import { HistoryList } from './components/HistoryList';
import { StreamingStatus } from './components/StreamingStatus';
import { SLASH_COMMANDS } from './slashCommands';
import { webviewDiagnostics } from './WebviewDiagnostics';

interface QueuedPrompt {
  id: string;
  conversationId: string;
  text: string;
  attachments: AttachmentData[];
}

export function App(): React.ReactElement {
  webviewDiagnostics.recordRender();
  const [state, dispatch] = useReducer(reducer, initialState);

  const [confirmRequest, setConfirmRequest] = useState<{
    id: string;
    toolName: string;
    detail: string;
    isDangerous?: boolean;
  } | null>(null);
  const [tokenUsed, setTokenUsed] = useState(0);
  const [tokenMax, setTokenMax] = useState(0);
  const [prefillText, setPrefillText] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  // Queued prompts belong in state so the user can see and cancel them before
  // Forge submits them to the extension host.
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  /** Prevent ordinary queue draining while a selected prompt is taking over. */
  const steeringConversationIds = useRef(new Set<string>());

  useEffect(() => {
    function handler(event: MessageEvent): void {
      const msg = event.data as HostToWebview;
      webviewDiagnostics.recordHostMessage(msg);
      switch (msg.type) {
        case 'generationStarted':
          if (msg.conversationId) steeringConversationIds.current.delete(msg.conversationId);
          dispatch({ type: 'GENERATION_STARTED', convId: msg.conversationId });
          break;
        case 'token':
          dispatch({ type: 'TOKEN', text: msg.text, convId: msg.conversationId });
          break;
        case 'notice':
          dispatch({ type: 'NOTICE', message: msg.message, convId: msg.conversationId });
          break;
        case 'reasoningToken':
          dispatch({ type: 'REASONING_TOKEN', text: msg.text, convId: msg.conversationId });
          break;
        case 'done':
          // A steering handoff first finishes the interrupted request, then
          // starts the redirected one. Keep the optimistic steered prompt and
          // the conversation's live state through that intermediate DONE;
          // generationStarted clears the handoff marker for the new request.
          if (msg.conversationId && steeringConversationIds.current.has(msg.conversationId)) {
            break;
          }
          dispatch({ type: 'DONE', convId: msg.conversationId });
          break;
        case 'error':
          if (msg.conversationId) steeringConversationIds.current.delete(msg.conversationId);
          dispatch({ type: 'ERROR', message: msg.message, convId: msg.conversationId });
          break;
        case 'ready':
          dispatch({ type: 'READY', convId: msg.conversationId });
          break;
        case 'backendStarting':
          dispatch({ type: 'BACKEND_STARTING', message: msg.message, convId: msg.conversationId });
          break;
        case 'backendDown':
          if (msg.conversationId) steeringConversationIds.current.delete(msg.conversationId);
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
          dispatch({
            type: 'SESSION_SYNC',
            activeId: msg.activeId,
            tabs: msg.tabs,
            history: msg.history,
            messagesById: msg.messagesById,
          });
          break;
        case 'confirmRequest':
          setConfirmRequest({
            id: msg.id,
            toolName: msg.toolName,
            detail: msg.detail,
            isDangerous: msg.isDangerous,
          });
          break;
        case 'tokenBudget':
          setTokenUsed(msg.used);
          setTokenMax(msg.max);
          break;
        case 'setInput':
          setPrefillText(msg.text);
          break;
        case 'clankerChanged':
          dispatch({ type: 'CLANKER_CHANGED', enabled: msg.enabled });
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

  const postPrompt = useCallback((prompt: QueuedPrompt) => {
    dispatch({ type: 'USER_SEND', text: prompt.text, convId: prompt.conversationId });
    vscode.postMessage({
      type: 'send',
      text: prompt.text,
      attachments: prompt.attachments.length ? prompt.attachments : undefined,
      conversationId: prompt.conversationId,
    });
  }, []);

  const handleSend = useCallback(
    (text: string, attachments: AttachmentData[]) => {
      const prompt = { conversationId: state.activeConversationId, text, attachments };
      if (state.streamingIds.has(prompt.conversationId)) {
        setQueuedPrompts((current) => [...current, { ...prompt, id: crypto.randomUUID() }]);
        return;
      }
      postPrompt({ ...prompt, id: crypto.randomUUID() });
    },
    [postPrompt, state.activeConversationId, state.streamingIds],
  );

  useEffect(() => {
    const nextIndex = queuedPrompts.findIndex(
      (prompt) =>
        !state.streamingIds.has(prompt.conversationId) &&
        !steeringConversationIds.current.has(prompt.conversationId),
    );
    if (nextIndex < 0) return;
    const next = queuedPrompts[nextIndex];
    if (!next) return;
    setQueuedPrompts((current) => current.filter((prompt) => prompt.id !== next.id));
    postPrompt(next);
  }, [postPrompt, queuedPrompts, state.streamingIds]);

  const cancelQueuedPrompt = useCallback((id: string) => {
    setQueuedPrompts((current) => current.filter((prompt) => prompt.id !== id));
  }, []);

  const steerQueuedPrompt = useCallback(
    (id: string) => {
      const prompt = queuedPrompts.find((candidate) => candidate.id === id);
      if (!prompt) return;
      steeringConversationIds.current.add(prompt.conversationId);
      setQueuedPrompts((current) => current.filter((candidate) => candidate.id !== id));
      // Replace the queued presentation with the same optimistic user row used
      // by an ordinary send. The host persists and reconciles it once the
      // interrupted request has released the conversation.
      dispatch({ type: 'USER_SEND', text: prompt.text, convId: prompt.conversationId });
      vscode.postMessage({
        type: 'steer',
        text: prompt.text,
        attachments: prompt.attachments.length ? prompt.attachments : undefined,
        conversationId: prompt.conversationId,
      });
    },
    [queuedPrompts],
  );

  const handleCancel = useCallback(() => {
    vscode.postMessage({ type: 'cancel' });
  }, []);
  const handleModelChange = useCallback((name: string | null) => {
    dispatch({ type: 'SET_MODEL', name });
    vscode.postMessage({ type: 'switchModel', name });
  }, []);
  const handleNewConversation = useCallback(() => {
    vscode.postMessage({ type: 'newConversation' });
  }, []);
  const handleSwitchTab = useCallback((id: string) => {
    vscode.postMessage({ type: 'switchConversation', id });
  }, []);
  const handleCloseTab = useCallback((id: string) => {
    vscode.postMessage({ type: 'closeConversation', id });
  }, []);
  const handleRestoreConversation = useCallback((id: string) => {
    vscode.postMessage({ type: 'restoreConversation', id });
  }, []);
  const handleDeleteConversation = useCallback((id: string) => {
    vscode.postMessage({ type: 'deleteConversation', id });
  }, []);
  const handleRenameConversation = useCallback((id: string, title: string) => {
    vscode.postMessage({ type: 'renameConversation', id, title });
  }, []);

  useEffect(() => {
    if (state.history.length === 0) setHistoryExpanded(false);
  }, [state.history.length]);

  const handleConfirmApprove = useCallback(() => {
    if (!confirmRequest) return;
    vscode.postMessage({ type: 'confirmResponse', id: confirmRequest.id, approved: true });
    setConfirmRequest(null);
  }, [confirmRequest]);

  const handleConfirmDeny = useCallback(() => {
    if (!confirmRequest) return;
    vscode.postMessage({ type: 'confirmResponse', id: confirmRequest.id, approved: false });
    setConfirmRequest(null);
  }, [confirmRequest]);

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
  const activeModelIsLocal =
    state.models.find((model) => model.name === state.activeModel)?.residency !== undefined;

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
    <div id="forge-root">
      <Header tokenUsed={tokenUsed} tokenMax={tokenMax} />
      <aside id="chats-panel" aria-label="Forge chats">
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
              historyCount={state.history.length}
              historyExpanded={historyExpanded}
              onSwitch={handleSwitchTab}
              onNew={handleNewConversation}
              onClose={handleCloseTab}
              onToggleHistory={() => setHistoryExpanded((expanded) => !expanded)}
            />
            <HistoryList
              items={state.history}
              expanded={historyExpanded}
              onRestore={handleRestoreConversation}
              onDelete={handleDeleteConversation}
              onRename={handleRenameConversation}
            />
          </>
        )}
      </aside>
      <MessageList
        messages={messages}
        queuedPrompts={queuedPrompts.filter(
          (prompt) => prompt.conversationId === state.activeConversationId,
        )}
        onCancelQueuedPrompt={cancelQueuedPrompt}
        onSteerQueuedPrompt={steerQueuedPrompt}
        streaming={streaming}
        conversationId={state.activeConversationId}
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
        activeConversationId={state.activeConversationId}
      />
      {confirmRequest && (
        <ConfirmationDialog
          toolName={confirmRequest.toolName}
          detail={confirmRequest.detail}
          isDangerous={confirmRequest.isDangerous}
          onApprove={handleConfirmApprove}
          onDeny={handleConfirmDeny}
        />
      )}
    </div>
  );
}
