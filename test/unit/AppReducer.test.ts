import { beforeAll, describe, expect, it } from 'vitest';

interface AppModule {
  initialState: {
    messages: unknown[];
    streaming: boolean;
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
});
