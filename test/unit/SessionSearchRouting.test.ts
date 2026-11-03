/**
 * The two webview messages the sessions panel's content search adds, as the
 * switch that routes them sees them: `sessionSearchQuery` is its own message,
 * while the panel-close release rides `jobsPanelClosed` — the message that says
 * the panel closed, not the message that says the Jobs tab closed. A release
 * wired only to the Jobs bridge would leave a transcript walk running after the
 * panel that started it had gone.
 */
import { describe, expect, it, vi } from 'vitest';
import { routeWebviewMessage, type WebviewActions } from '../../src/sidebar/webviewMessageRouter';
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
    getClankerStates: vi.fn(() => []),
    getRemoteStatus: vi.fn(() => ({ transports: [], paired: false })),
    pendingQuestions: vi.fn(() => []),
    pendingApproval: vi.fn(() => undefined),
    jobsPanelOpened: vi.fn(),
    jobsPanelClosed: vi.fn(),
    openJob: vi.fn(),
    sessionSearchQuery: vi.fn(),
    sessionSearchClosed: vi.fn(),
  };
  return { ...defaults, ...overrides } as unknown as WebviewActions;
}

const postedFrom = (actions: WebviewActions): HostToWebview[] =>
  (actions.post as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => message as HostToWebview);

describe('the content search messages', () => {
  it('hands the query to the search bridge and to nothing else', () => {
    const jobsPanelOpened = vi.fn();
    const sessionSearchQuery = vi.fn();
    const actions = makeActions({ jobsPanelOpened, sessionSearchQuery });
    const message = {
      type: 'sessionSearchQuery',
      panelId: 3,
      requestId: 2,
      tab: 'archived',
      query: 'wobble',
    } as const;

    routeWebviewMessage(actions, message);

    expect(sessionSearchQuery).toHaveBeenCalledWith(message);
    // Asking the host to read transcripts is not the same as asking it to push
    // the job store: a query must not start a store subscription.
    expect(jobsPanelOpened).not.toHaveBeenCalled();
    expect(postedFrom(actions)).toHaveLength(0);
  });

  it('releases the transcript walk when the panel closes, beside the store push', () => {
    const jobsPanelClosed = vi.fn();
    const sessionSearchClosed = vi.fn();
    const actions = makeActions({ jobsPanelClosed, sessionSearchClosed });

    routeWebviewMessage(actions, { type: 'jobsPanelClosed', panelId: 3 });

    expect(jobsPanelClosed).toHaveBeenCalledWith(3);
    expect(sessionSearchClosed).toHaveBeenCalledWith(3);
  });

  it('does not release the walk when the panel opened', () => {
    const actions = makeActions();
    routeWebviewMessage(actions, { type: 'jobsPanelOpened', panelId: 3 });
    expect((actions.sessionSearchClosed as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((actions.sessionSearchQuery as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
