import { beforeAll, describe, expect, it } from 'vitest';

interface AppModule {
  initialState: {
    messagesById: Record<string, Array<{ role: string; content: string }>>;
    streamingIds: Set<string>;
    generatingIds: Set<string>;
    models: string[];
    activeModel: string | null;
    backendReady: boolean;
    checkpointPending: boolean;
    sessionHydrated: boolean;
    tabs: unknown[];
    history: unknown[];
    activeConversationId: string;
  };
  reducer: (
    state: AppModule['initialState'],
    action:
      | { type: 'MODELS'; names: string[]; active: string | null }
      | { type: 'GENERATION_STARTED'; convId?: string }
      | { type: 'USER_SEND'; text: string; convId?: string }
      | { type: 'DONE'; convId?: string }
      | { type: 'ERROR'; message: string; convId?: string }
      | { type: 'READY'; convId?: string }
      | { type: 'BACKEND_DOWN'; message: string; convId?: string }
      | {
          type: 'SESSION_SYNC';
          activeId: string;
          tabs: Array<{
            id: string;
            title: string;
            createdAt: number;
            updatedAt: number;
            messageCount: number;
            active_model?: string;
          }>;
          history: Array<{
            id: string;
            title: string;
            createdAt: number;
            updatedAt: number;
            messageCount: number;
            active_model?: string;
          }>;
          messagesById: Record<
            string,
            Array<{ role: 'user' | 'assistant'; content: string; reasoning?: string }>
          >;
        },
  ) => AppModule['initialState'];
}

let appModule: AppModule;

beforeAll(async () => {
  (
    globalThis as typeof globalThis & {
      acquireVsCodeApi?: () => {
        postMessage: () => void;
        getState: () => unknown;
        setState: () => void;
      };
    }
  ).acquireVsCodeApi = () => ({
    postMessage: () => undefined,
    getState: () => undefined,
    setState: () => undefined,
  });

  appModule = (await import('../../webview-ui/src/reducer')) as AppModule;
});

describe('webview App reducer', () => {
  it('tracks command-started generation until completion', () => {
    const running = appModule.reducer(appModule.initialState, {
      type: 'GENERATION_STARTED',
      convId: 'tab-1',
    });
    expect(running.streamingIds.has('tab-1')).toBe(true);
    expect(running.generatingIds.has('tab-1')).toBe(true);

    const done = appModule.reducer(running, { type: 'DONE', convId: 'tab-1' });
    expect(done.streamingIds.has('tab-1')).toBe(false);
    expect(done.generatingIds.has('tab-1')).toBe(false);
  });

  it('adds a queued prompt to its original conversation rather than the active tab', () => {
    const state = {
      ...appModule.initialState,
      activeConversationId: 'tab-2',
      messagesById: { 'tab-1': [{ role: 'assistant', content: 'Working…' }] },
    };

    const queued = appModule.reducer(state, {
      type: 'USER_SEND',
      text: 'Follow up when you finish.',
      convId: 'tab-1',
    });

    expect(queued.messagesById['tab-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Follow up when you finish.' }),
      ]),
    );
    expect(queued.messagesById['tab-2']).toBeUndefined();
  });

  it('clears a prior provider error when a user retries with another model', () => {
    const failed = appModule.reducer(appModule.initialState, {
      type: 'ERROR',
      convId: 'tab-1',
      message: 'Claude usage limit reached',
    });

    const retried = appModule.reducer(failed, {
      type: 'USER_SEND',
      convId: 'tab-1',
      text: 'Try this with Codex instead.',
    });

    expect(retried.messagesById['tab-1']).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'error', content: 'Claude usage limit reached' }),
      ]),
    );
  });

  it('keeps the model selector empty when restoring tabs', () => {
    const withNoActiveModel = appModule.reducer(appModule.initialState, {
      type: 'MODELS',
      names: ['qwen', 'gemma'],
      active: null,
    });

    const synced = appModule.reducer(withNoActiveModel, {
      type: 'SESSION_SYNC',
      activeId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'Chat',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 1,
          active_model: 'qwen',
        },
      ],
      history: [],
      messagesById: {
        'tab-1': [{ role: 'user', content: 'hello' }],
      },
    });

    expect(synced.activeModel).toBeNull();
    expect(synced.messagesById['tab-1']).toHaveLength(1);
  });

  it('keeps an actionable chat error through session reconciliation', () => {
    const hydrated = appModule.reducer(appModule.initialState, {
      type: 'SESSION_SYNC',
      activeId: 'tab-1',
      tabs: [],
      history: [],
      messagesById: { 'tab-1': [{ role: 'user', content: 'hello' }] },
    });
    const failed = appModule.reducer(hydrated, {
      type: 'ERROR',
      convId: 'tab-1',
      message: 'HTTP 404: cloud model unavailable',
    });
    const reconciled = appModule.reducer(failed, {
      type: 'SESSION_SYNC',
      activeId: 'tab-1',
      tabs: [],
      history: [],
      messagesById: { 'tab-1': [{ role: 'user', content: 'hello' }] },
    });

    expect(reconciled.messagesById['tab-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'error', content: 'HTTP 404: cloud model unavailable' }),
      ]),
    );
  });

  it('clears a recovered backend-start error without removing chat errors', () => {
    const failed = appModule.reducer(appModule.initialState, {
      type: 'BACKEND_DOWN',
      convId: 'tab-1',
      message: 'Backend failed to start: llama-server exited with code 1',
    });
    const withChatError = appModule.reducer(failed, {
      type: 'ERROR',
      convId: 'tab-1',
      message: 'HTTP 404: cloud model unavailable',
    });
    const recovered = appModule.reducer(withChatError, { type: 'READY', convId: 'tab-1' });

    expect(recovered.messagesById['tab-1']).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'error', content: expect.stringContaining('Backend failed') }),
      ]),
    );
    expect(recovered.messagesById['tab-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'error', content: 'HTTP 404: cloud model unavailable' }),
      ]),
    );
  });
});
