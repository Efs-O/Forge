import { useCallback, useRef, useState } from 'react';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { StructuredAnswer } from '../../src/util/questionAnswers';
import { vscode } from './vscode';

type QuestionMessage = Extract<HostToWebview, { type: 'question' }>;

export interface AgentQuestion extends QuestionMessage {
  focusOnOpen: boolean;
}

export interface QuestionDraft {
  tab: number;
  picks: number[][];
  notes: string[];
}

export interface AgentDialogs {
  confirmRequest: {
    id: string;
    toolName: string;
    detail: string;
    isDangerous?: boolean;
  } | null;
  questions: ReadonlyMap<string, AgentQuestion>;
  drafts: ReadonlyMap<string, QuestionDraft>;
  handleHostMessage: (msg: HostToWebview) => boolean;
  approveConfirm: () => void;
  denyConfirm: () => void;
  updateQuestionDraft: (id: string, draft: QuestionDraft) => void;
  answerQuestion: (id: string, answer: StructuredAnswer) => void;
  skipQuestion: (id: string) => void;
}

/** The oldest unresolved request that belongs to the active conversation. */
export function selectVisibleQuestion(
  questions: Iterable<AgentQuestion>,
  activeConversationId: string,
): AgentQuestion | undefined {
  for (const question of questions) {
    if (!question.conversationId || question.conversationId === activeConversationId) {
      return question;
    }
  }
  return undefined;
}

function initialDraft(specs: QuestionMessage['specs']): QuestionDraft {
  return {
    tab: 0,
    picks: specs.map(() => []),
    notes: specs.map(() => ''),
  };
}

function removeQuestion<V>(values: Map<string, V>, id: string): Map<string, V> {
  if (!values.has(id)) return values;
  const next = new Map(values);
  next.delete(id);
  return next;
}

export function useAgentDialogs(activeConversationId: string): AgentDialogs {
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const [confirmRequest, setConfirmRequest] = useState<AgentDialogs['confirmRequest']>(null);
  const [questions, setQuestions] = useState<Map<string, AgentQuestion>>(() => new Map());
  const [drafts, setDrafts] = useState<Map<string, QuestionDraft>>(() => new Map());

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
        setConfirmRequest((current) => (current?.id === msg.id ? null : current));
        return true;
      case 'question':
        setQuestions((current) => {
          if (current.has(msg.id)) return current;
          const next = new Map(current);
          next.set(msg.id, {
            ...msg,
            focusOnOpen:
              typeof document === 'undefined' ||
              document.activeElement?.id !== 'prompt' ||
              Boolean(msg.conversationId && msg.conversationId !== activeConversationIdRef.current),
          });
          return next;
        });
        setDrafts((current) => {
          if (current.has(msg.id)) return current;
          const next = new Map(current);
          next.set(msg.id, initialDraft(msg.specs));
          return next;
        });
        return true;
      case 'questionResolved':
        setQuestions((current) => removeQuestion(current, msg.id));
        setDrafts((current) => removeQuestion(current, msg.id));
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

  const updateQuestionDraft = useCallback((id: string, draft: QuestionDraft) => {
    setDrafts((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.set(id, draft);
      return next;
    });
  }, []);

  const answerQuestion = useCallback(
    (id: string, answer: StructuredAnswer) => {
      if (!questions.has(id)) return;
      vscode.postMessage({ type: 'questionResponse', id, kind: 'answer', answer });
    },
    [questions],
  );

  const skipQuestion = useCallback(
    (id: string) => {
      if (!questions.has(id)) return;
      vscode.postMessage({ type: 'questionResponse', id, kind: 'skip' });
    },
    [questions],
  );

  return {
    confirmRequest,
    questions,
    drafts,
    handleHostMessage,
    approveConfirm,
    denyConfirm,
    updateQuestionDraft,
    answerQuestion,
    skipQuestion,
  };
}
