import React, { useEffect, useReducer, useCallback, useState } from 'react';
import type {
  AttachmentData,
  ForgeSlashCommandId,
  HostToWebview,
  SessionHistoryMeta,
  SessionTabMeta,
} from '../../src/sidebar/messageBridge';
import { vscode } from './vscode';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { CheckpointBar } from './components/CheckpointBar';
import { InputRow } from './components/InputRow';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { TabStrip } from './components/TabStrip';
import { HistoryList } from './components/HistoryList';
import { SLASH_COMMANDS } from './slashCommands';

export interface AppMessage {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'system';
  content: string;
  reasoning?: string | undefined;
}

interface State {
  messages: AppMessage[];
  streaming: boolean;
  /** True from USER_SEND until DONE/ERROR/BACKEND_DOWN — covers backend startup + token streaming. */
  generating: boolean;
  models: string[];
  activeModel: string | null;
  backendReady: boolean;
  checkpointPending: boolean;
  /** Set when host sends first sessionSync — tab row is authoritative for threads. */
  sessionHydrated: boolean;
  tabs: SessionTabMeta[];
  history: SessionHistoryMeta[];
  activeConversationId: string;
}

type Action =
  | { type: 'TOKEN'; text: string }
  | { type: 'REASONING_TOKEN'; text: string }
  | { type: 'DONE' }
  | { type: 'ERROR'; message: string }
  | { type: 'READY' }
  | { type: 'BACKEND_STARTING'; message: string }
  | { type: 'BACKEND_DOWN'; message: string }
  | { type: 'MODELS'; names: string[]; active: string | null }
  | { type: 'USER_SEND'; text: string }
  | { type: 'SET_MODEL'; name: string | null }
  | { type: 'CHECKPOINT_READY' }
  | { type: 'CHECKPOINT_DISMISSED' }
  | {
      type: 'SESSION_SYNC';
      activeId: string;
      tabs: SessionTabMeta[];
      history: SessionHistoryMeta[];
      messagesById: Record<string, Array<{ role: 'user' | 'assistant'; content: string; reasoning?: string | undefined }>>;
    };

function mkId(): string {
  return Math.random().toString(36).slice(2);
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'USER_SEND': {
      const last = state.messages[state.messages.length - 1];
      const base =
        last?.role === 'assistant' && last.content === ''
          ? state.messages.slice(0, -1)
          : state.messages;
      return {
        ...state,
        streaming: true,
        generating: true,
        checkpointPending: false,
        messages: [...base, { id: mkId(), role: 'user', content: action.text }],
      };
    }

    case 'TOKEN': {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') {
        return {
          ...state,
          messages: [
            ...state.messages.slice(0, -1),
            { ...last, content: last.content + action.text },
          ],
        };
      }
      return {
        ...state,
        messages: [...state.messages, { id: mkId(), role: 'assistant', content: action.text }],
      };
    }

    case 'REASONING_TOKEN': {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') {
        return {
          ...state,
          messages: [
            ...state.messages.slice(0, -1),
            { ...last, reasoning: (last.reasoning ?? '') + action.text },
          ],
        };
      }
      return {
        ...state,
        messages: [...state.messages, { id: mkId(), role: 'assistant', content: '', reasoning: action.text }],
      };
    }

    case 'DONE':
      return { ...state, streaming: false, generating: false };

    case 'ERROR':
      return {
        ...state,
        streaming: false,
        generating: false,
        messages: [...state.messages, { id: mkId(), role: 'error', content: action.message }],
      };

    case 'READY':
      return {
        ...state,
        backendReady: true,
        messages: [...state.messages, { id: mkId(), role: 'system', content: 'Backend ready.' }],
      };

    case 'BACKEND_STARTING':
      return {
        ...state,
        backendReady: false,
        messages: [...state.messages, { id: mkId(), role: 'system', content: action.message }],
      };

    case 'BACKEND_DOWN':
      return {
        ...state,
        streaming: false,
        generating: false,
        backendReady: false,
        messages: [...state.messages, { id: mkId(), role: 'system', content: action.message }],
      };

    case 'MODELS':
      return { ...state, models: action.names, activeModel: action.active };

    case 'SET_MODEL':
      return { ...state, activeModel: action.name };

    case 'CHECKPOINT_READY':
      return { ...state, checkpointPending: true };

    case 'CHECKPOINT_DISMISSED':
      return { ...state, checkpointPending: false };

    case 'SESSION_SYNC': {
      const rows = action.messagesById[action.activeId] ?? [];
      const restored: AppMessage[] = rows.map((m) => ({
        id: mkId(),
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
      }));
      return {
        ...state,
        sessionHydrated: true,
        tabs: action.tabs,
        history: action.history,
        activeConversationId: action.activeId,
        messages: restored,
      };
    }

    default:
      return state;
  }
}

export const initialState: State = {
  messages: [],
  streaming: false,
  generating: false,
  models: [],
  activeModel: null,
  backendReady: false,
  checkpointPending: false,
  sessionHydrated: false,
  tabs: [],
  history: [],
  activeConversationId: '',
};

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

  useEffect(() => {
    function handler(event: MessageEvent): void {
      const msg = event.data as HostToWebview;
      switch (msg.type) {
        case 'token':               dispatch({ type: 'TOKEN', text: msg.text }); break;
        case 'reasoningToken':      dispatch({ type: 'REASONING_TOKEN', text: msg.text }); break;
        case 'done':                dispatch({ type: 'DONE' }); break;
        case 'error':               dispatch({ type: 'ERROR', message: msg.message }); break;
        case 'ready':               dispatch({ type: 'READY' }); break;
        case 'backendStarting':     dispatch({ type: 'BACKEND_STARTING', message: msg.message }); break;
        case 'backendDown':         dispatch({ type: 'BACKEND_DOWN', message: msg.message }); break;
        case 'models':              dispatch({ type: 'MODELS', names: msg.names, active: msg.active }); break;
        case 'checkpointReady':     dispatch({ type: 'CHECKPOINT_READY' }); break;
        case 'checkpointDismissed': dispatch({ type: 'CHECKPOINT_DISMISSED' }); break;
        case 'sessionSync':
          dispatch({
            type: 'SESSION_SYNC',
            activeId: msg.activeId,
            tabs: msg.tabs,
            history: msg.history,
            messagesById: msg.messagesById,
          });
          break;
        case 'confirmRequest':      setConfirmRequest({ id: msg.id, toolName: msg.toolName, detail: msg.detail, isDangerous: msg.isDangerous }); break;
        case 'tokenBudget':         setTokenUsed(msg.used); setTokenMax(msg.max); break;
        case 'setInput':
          setPrefillText(msg.text);
          break;
        case 'historyRestore':
        case 'newChat':
          break;
      }
    }
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'webviewReady' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleSend = useCallback((text: string, attachments: AttachmentData[]) => {
    dispatch({ type: 'USER_SEND', text });
    vscode.postMessage({ type: 'send', text, attachments: attachments.length ? attachments : undefined });
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

  const uiBusy = state.generating;

  return (
    <div id="forge-root">
      <Header
        models={state.models}
        activeModel={state.activeModel}
        onModelChange={handleModelChange}
        disabled={uiBusy}
        streaming={state.streaming}
        tokenUsed={tokenUsed}
        tokenMax={tokenMax}
      />
      <aside id="chats-panel" aria-label="Forge chats">
        {!state.sessionHydrated && (
          <span id="chats-loading" role="status">Loading…</span>
        )}
        {state.sessionHydrated && (
          <>
            <TabStrip
              tabs={state.tabs}
              activeId={state.activeConversationId}
              onSwitch={handleSwitchTab}
              onNew={handleNewConversation}
              onClose={handleCloseTab}
            />
            <HistoryList
              items={state.history}
              onRestore={handleRestoreConversation}
            />
          </>
        )}
      </aside>
      <MessageList messages={state.messages} streaming={state.streaming} generating={state.generating} />
      <CheckpointBar visible={state.checkpointPending} />
      <InputRow
        onSend={handleSend}
        onCancel={handleCancel}
        streaming={state.streaming}
        backendReady={state.backendReady}
        slashCommands={SLASH_COMMANDS}
        onRunSlashCommand={handleRunSlashCommand}
        prefillText={prefillText}
        onPrefillConsumed={() => setPrefillText(null)}
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
