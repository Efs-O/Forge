import { useCallback, useState } from 'react';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import { vscode } from './vscode';

/**
 * The two modal dialogs a turn can raise: a tool approval, and an `ask_user`
 * question.
 *
 * Extracted from `App` because they are one concern with a shared rule -- both
 * can be settled by a surface other than this webview, so both need a `resolved`
 * message to close the dialog without answering it, and both must ignore a late
 * resolve that names an older request than the one on screen. Keeping the pair
 * together is what makes that rule visible; in `App` it was two unrelated
 * `useState`s forty lines apart.
 */

export interface ConfirmRequestState {
  id: string;
  toolName: string;
  detail: string;
  isDangerous?: boolean;
}

export interface QuestionState {
  id: string;
  prompt: string;
  placeholder?: string | undefined;
  options?: readonly string[] | undefined;
}

export interface AgentDialogs {
  confirmRequest: ConfirmRequestState | null;
  question: QuestionState | null;
  /** Returns true when the message was a dialog message and is fully handled. */
  handleHostMessage: (msg: HostToWebview) => boolean;
  approveConfirm: () => void;
  denyConfirm: () => void;
  answerQuestion: (text: string) => void;
  dismissQuestion: () => void;
}

export function useAgentDialogs(): AgentDialogs {
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequestState | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);

  const handleHostMessage = useCallback((msg: HostToWebview): boolean => {
    switch (msg.type) {
      case 'confirmRequest':
        setConfirmRequest({
          id: msg.id,
          toolName: msg.toolName,
          detail: msg.detail,
          isDangerous: msg.isDangerous,
        });
        return true;
      case 'confirmResolved':
        // Only clear the dialog we are actually showing: a late resolve for an
        // older approval must not dismiss the one now on screen.
        setConfirmRequest((current) => (current?.id === msg.id ? null : current));
        return true;
      case 'question':
        setQuestion({
          id: msg.id,
          prompt: msg.prompt,
          placeholder: msg.placeholder,
          options: msg.options,
        });
        return true;
      case 'questionResolved':
        // Settled somewhere else — a paired chat answered it, or the turn was
        // cancelled. Same guard as confirmResolved, for the same reason.
        setQuestion((current) => (current?.id === msg.id ? null : current));
        return true;
      default:
        return false;
    }
  }, []);

  const approveConfirm = useCallback(() => {
    if (!confirmRequest) return;
    vscode.postMessage({ type: 'confirmResponse', id: confirmRequest.id, approved: true });
    setConfirmRequest(null);
  }, [confirmRequest]);

  const denyConfirm = useCallback(() => {
    if (!confirmRequest) return;
    vscode.postMessage({ type: 'confirmResponse', id: confirmRequest.id, approved: false });
    setConfirmRequest(null);
  }, [confirmRequest]);

  const answerQuestion = useCallback(
    (text: string) => {
      if (!question) return;
      vscode.postMessage({ type: 'questionResponse', id: question.id, text });
      setQuestion(null);
    },
    [question],
  );

  const dismissQuestion = useCallback(() => {
    if (!question) return;
    // No `text` at all, not an empty one: the host reports a dismissal to the
    // model as "the user did not answer", where a blank string would read as one.
    vscode.postMessage({ type: 'questionResponse', id: question.id });
    setQuestion(null);
  }, [question]);

  return {
    confirmRequest,
    question,
    handleHostMessage,
    approveConfirm,
    denyConfirm,
    answerQuestion,
    dismissQuestion,
  };
}
