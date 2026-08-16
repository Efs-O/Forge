import React, { useEffect, useMemo, useReducer, useCallback, useState } from 'react';
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
import { SLASH_COMMANDS } from './slashCommands';

interface QueuedPrompt {
  id: string;
  conversationId: string;
  text: string;
  attachments: AttachmentData[];
}

export function App(): React.ReactElement {
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
  // Queued prompts belong in state so the user can see and cancel them before
  // Forge submits them to the extension host.
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);

  useEffect(() => {
    function handler(event: MessageEvent): void {
      const msg = event.data as HostToWebview;
      switch (msg.type) {
        case 'generationStarted':
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
          dispatch({ type: 'DONE', convId: msg.conversationId });
          break;
        case 'error':
          dispatch({ type: 'ERROR', message: msg.message, convId: msg.conversationId });
          break;
        case 'ready':
          dispatch({ type: 'READY', convId: msg.conversationId });
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
            detail: msg.detail,
            convId: msg.conversationId,
          });
          break;
        case 'toolResult':
          dispatch({
            type: 'TOOL_RESULT',
            toolName: msg.toolName,
            label: msg.label,
            text: msg.text,
            totalChars: msg.totalChars,
            ...(msg.filePath ? { filePath: msg.filePath } : {}),
            ...(msg.isError ? { isError: true } : {}),
            convId: msg.conversationId,
          });
          break;
        case 'workerStatus': {
          const worker = [msg.workerId, msg.model].filter(Boolean).join(' / ');
          const mode = msg.executionMode ? ` (${msg.executionMode})` : '';
          const status = msg.status ? `: ${msg.status}` : '';
          const paths = msg.changedPaths?.length ? ` → ${msg.changedPaths.join(', ')}` : '';
          dispatch({
            type: 'TOOL_ACTIVITY',
            toolName: worker || 'workers',
            detail: `${msg.stage}${mode}${status} · ${msg.elapsedMs}ms${paths}`,
            convId: msg.conversationId,
          });
          break;
        }
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
      (prompt) => !state.streamingIds.has(prompt.conversationId),
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

  // Unused tab/history types satisfy TS — keep them aligned with SessionSyncMsg shape
  void ([] as SessionTabMeta[]);
  void ([] as SessionHistoryMeta[]);

  const messages = selectMessages(state);
  const streaming = selectStreaming(state);
  const generating = selectGenerating(state);
  const uiBusy = generating;

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
      <Header
        models={state.models}
        activeModel={state.activeModel}
        onModelChange={handleModelChange}
        disabled={uiBusy}
        streaming={streaming}
        tokenUsed={tokenUsed}
        tokenMax={tokenMax}
      />
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
              onSwitch={handleSwitchTab}
              onNew={handleNewConversation}
              onClose={handleCloseTab}
            />
            <HistoryList items={state.history} onRestore={handleRestoreConversation} />
          </>
        )}
      </aside>
      <MessageList
        messages={messages}
        queuedPrompts={queuedPrompts.filter(
          (prompt) => prompt.conversationId === state.activeConversationId,
        )}
        onCancelQueuedPrompt={cancelQueuedPrompt}
        streaming={streaming}
        generating={generating}
        conversationId={state.activeConversationId}
      />
      {streaming && (
        <div id="streaming-status" role="status" aria-live="polite">
          <span className="streaming-status-dot" />
          Burning tokens…
        </div>
      )}
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
        onPrefillConsumed={() => setPrefillText(null)}
        clankerMode={state.clankerMode}
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
