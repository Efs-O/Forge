import React, { useEffect, useReducer, useCallback } from 'react';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { Mode } from '../../src/llm/types';
import { vscode } from './vscode';
import { Header } from './components/Header';
import { MessageList } from './components/MessageList';
import { CheckpointBar } from './components/CheckpointBar';
import { InputRow } from './components/InputRow';

export interface AppMessage {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'system';
  content: string;
}

interface State {
  messages: AppMessage[];
  streaming: boolean;
  models: string[];
  activeModel: string;
  mode: Mode;
  backendReady: boolean;
  checkpointPending: boolean;
}

type Action =
  | { type: 'TOKEN'; text: string }
  | { type: 'DONE' }
  | { type: 'ERROR'; message: string }
  | { type: 'READY' }
  | { type: 'BACKEND_DOWN'; message: string }
  | { type: 'MODELS'; names: string[]; active: string }
  | { type: 'USER_SEND'; text: string }
  | { type: 'SET_MODE'; mode: Mode }
  | { type: 'SET_MODEL'; name: string }
  | { type: 'CHECKPOINT_READY' }
  | { type: 'CHECKPOINT_DISMISSED' }
  | { type: 'NEW_CHAT' };

function mkId(): string {
  return Math.random().toString(36).slice(2);
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'USER_SEND':
      return {
        ...state,
        streaming: true,
        checkpointPending: false,
        messages: [...state.messages, { id: mkId(), role: 'user', content: action.text }],
      };

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

    case 'DONE':
      return { ...state, streaming: false };

    case 'ERROR':
      return {
        ...state,
        streaming: false,
        messages: [...state.messages, { id: mkId(), role: 'error', content: action.message }],
      };

    case 'READY':
      return {
        ...state,
        backendReady: true,
        messages: [...state.messages, { id: mkId(), role: 'system', content: 'Backend ready.' }],
      };

    case 'BACKEND_DOWN':
      return {
        ...state,
        backendReady: false,
        messages: [...state.messages, { id: mkId(), role: 'system', content: action.message }],
      };

    case 'MODELS':
      return { ...state, models: action.names, activeModel: action.active };

    case 'SET_MODE':
      return { ...state, mode: action.mode };

    case 'SET_MODEL':
      return { ...state, activeModel: action.name, messages: [], streaming: false, checkpointPending: false };

    case 'CHECKPOINT_READY':
      return { ...state, checkpointPending: true };

    case 'CHECKPOINT_DISMISSED':
      return { ...state, checkpointPending: false };

    case 'NEW_CHAT':
      return {
        ...state,
        messages: [],
        streaming: false,
        checkpointPending: false,
      };

    default:
      return state;
  }
}

const initial: State = {
  messages: [],
  streaming: false,
  models: [],
  activeModel: '',
  mode: 'ask',
  backendReady: false,
  checkpointPending: false,
};

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    function handler(event: MessageEvent): void {
      const msg = event.data as HostToWebview;
      switch (msg.type) {
        case 'token':               dispatch({ type: 'TOKEN', text: msg.text }); break;
        case 'done':                dispatch({ type: 'DONE' }); break;
        case 'error':               dispatch({ type: 'ERROR', message: msg.message }); break;
        case 'ready':               dispatch({ type: 'READY' }); break;
        case 'backendDown':         dispatch({ type: 'BACKEND_DOWN', message: msg.message }); break;
        case 'models':              dispatch({ type: 'MODELS', names: msg.names, active: msg.active }); break;
        case 'checkpointReady':     dispatch({ type: 'CHECKPOINT_READY' }); break;
        case 'checkpointDismissed': dispatch({ type: 'CHECKPOINT_DISMISSED' }); break;
        case 'newChat':             dispatch({ type: 'NEW_CHAT' }); break;
      }
    }
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'webviewReady' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleSend = useCallback((text: string) => {
    dispatch({ type: 'USER_SEND', text });
    vscode.postMessage({ type: 'send', text, mode: state.mode });
  }, [state.mode]);

  const handleCancel = useCallback(() => {
    vscode.postMessage({ type: 'cancel' });
  }, []);

  const handleModelChange = useCallback((name: string) => {
    dispatch({ type: 'SET_MODEL', name });
    vscode.postMessage({ type: 'switchModel', name });
  }, []);

  const handleModeChange = useCallback((mode: Mode) => {
    dispatch({ type: 'SET_MODE', mode });
  }, []);

  const handleNewChat = useCallback(() => {
    dispatch({ type: 'NEW_CHAT' });
    vscode.postMessage({ type: 'newChat' });
  }, []);

  return (
    <div id="forge-root">
      <Header
        models={state.models}
        activeModel={state.activeModel}
        mode={state.mode}
        onModelChange={handleModelChange}
        onModeChange={handleModeChange}
        onNewChat={handleNewChat}
        disabled={state.streaming}
      />
      <MessageList messages={state.messages} />
      <CheckpointBar visible={state.checkpointPending} />
      <InputRow
        onSend={handleSend}
        onCancel={handleCancel}
        streaming={state.streaming}
        backendReady={state.backendReady}
      />
    </div>
  );
}
