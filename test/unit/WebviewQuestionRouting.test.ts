import { describe, expect, it, vi } from 'vitest';
import { normalizeQuestions } from '../../src/util/questionAnswers';
import { routeWebviewMessage, type WebviewActions } from '../../src/sidebar/webviewMessageRouter';
import type { UserQuestionRequestEvent } from '../../src/sidebar/UserQuestionService';
import type { ToolApprovalRequestEvent } from '../../src/sidebar/ToolApprovalService';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

function makeActions(overrides: Partial<WebviewActions> = {}): WebviewActions {
  const defaults = {
    post: vi.fn(),
    postModels: vi.fn(),
    postSessionSync: vi.fn(),
    postActivityView: vi.fn(() => undefined),
    postTokenBudget: vi.fn(),
    postWorkspaceInfo: vi.fn(),
    isBackendReady: vi.fn(() => false),
    getClankerMode: vi.fn(() => false),
    getRemoteStatus: vi.fn(() => ({ transports: [], paired: false })),
    pendingQuestions: vi.fn(() => []),
    pendingApproval: vi.fn(() => undefined),
    answerQuestion: vi.fn(),
    skipQuestion: vi.fn(),
  };
  return { ...defaults, ...overrides } as unknown as WebviewActions;
}

describe('question messages from the sidebar', () => {
  it('reposts pending questions before the pending approval on webviewReady', () => {
    const question: UserQuestionRequestEvent = {
      id: 'q-1',
      prompt: 'Database?',
      specs: normalizeQuestions({ prompt: 'Database?', options: ['SQLite', 'Postgres'] }),
      conversationId: 'chat-1',
    };
    const approval: ToolApprovalRequestEvent = {
      id: 'approval-1',
      toolName: 'write_file',
      detail: 'src/db.ts',
      dangerous: true,
      conversationId: 'chat-1',
    };
    const post = vi.fn<(message: HostToWebview) => void>();
    const actions = makeActions({
      post,
      pendingQuestions: () => [question],
      pendingApproval: () => approval,
    });

    routeWebviewMessage(actions, { type: 'webviewReady' });

    const messages = post.mock.calls.map(([message]) => message);
    const questionIndex = messages.findIndex((message) => message.type === 'question');
    const approvalIndex = messages.findIndex((message) => message.type === 'confirmRequest');
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    expect(approvalIndex).toBeGreaterThan(questionIndex);
    expect(messages[questionIndex]).toMatchObject({
      type: 'question',
      id: question.id,
      specs: question.specs,
      conversationId: 'chat-1',
    });
    expect(messages[approvalIndex]).toEqual({
      type: 'confirmRequest',
      id: approval.id,
      toolName: approval.toolName,
      detail: approval.detail,
      isDangerous: true,
      conversationId: 'chat-1',
    });
  });

  it('routes structured answers and explicit skips to separate host actions', () => {
    const answerQuestion = vi.fn();
    const skipQuestion = vi.fn();
    const actions = makeActions({ answerQuestion, skipQuestion });

    routeWebviewMessage(actions, {
      type: 'questionResponse',
      id: 'q-1',
      kind: 'answer',
      answer: { answers: [{ picks: [1], note: 'keep the current data' }] },
    });
    routeWebviewMessage(actions, { type: 'questionResponse', id: 'q-2', kind: 'skip' });

    expect(answerQuestion).toHaveBeenCalledWith('q-1', {
      answers: [{ picks: [1], note: 'keep the current data' }],
    });
    expect(skipQuestion).toHaveBeenCalledWith('q-2');
  });
});
