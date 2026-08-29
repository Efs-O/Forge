import { beforeAll, describe, expect, it } from 'vitest';

interface AppModule {
  initialState: {
    messagesById: Record<
      string,
      Array<{ role: string; content: string; toolName?: string; toolResult?: string }>
    >;
    streamingIds: Set<string>;
    generatingIds: Set<string>;
    models: string[];
    activeModel: string | null;
    backendReady: boolean;
    checkpointPendingIds: Set<string>;
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
      | { type: 'CHECKPOINT_READY'; convId?: string }
      | { type: 'CHECKPOINT_DISMISSED'; convId?: string }
      | { type: 'TOOL_ACTIVITY'; toolName: string; detail?: string; convId?: string }
      | {
          type: 'TOOL_RESULT';
          toolName: string;
          label: string;
          text: string;
          totalChars: number;
          filePath?: string;
          isError?: boolean;
          convId?: string;
        }
      | { type: 'USER_SEND'; text: string; convId?: string }
      | { type: 'DONE'; convId?: string }
      | { type: 'ERROR'; message: string; convId?: string }
      | { type: 'READY'; convId?: string }
      | { type: 'BACKEND_STARTING'; message: string; convId?: string }
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
            streaming?: boolean;
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
  selectCheckpointPending: (state: AppModule['initialState']) => boolean;
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

  it('recovers Stop state when generation started before the webview was restored', () => {
    const synced = appModule.reducer(appModule.initialState, {
      type: 'SESSION_SYNC',
      activeId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'Chat',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 1,
          streaming: true,
        },
      ],
      history: [],
      messagesById: { 'tab-1': [{ role: 'user', content: 'continue' }] },
    });

    expect(synced.streamingIds.has('tab-1')).toBe(true);
    expect(synced.generatingIds.has('tab-1')).toBe(true);
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

  it('answers a start announcement with "Backend ready." exactly once', () => {
    const starting = appModule.reducer(appModule.initialState, {
      type: 'BACKEND_STARTING',
      convId: 'tab-1',
      message: 'Starting backend, please wait…',
    });
    const ready = appModule.reducer(starting, { type: 'READY', convId: 'tab-1' });

    expect(ready.backendReady).toBe(true);
    expect(ready.messagesById['tab-1']?.map((m) => m.content)).toEqual([
      'Starting backend, please wait…',
      'Backend ready.',
    ]);
  });

  it('stays silent on a warm acquire that never announced a start', () => {
    const ready = appModule.reducer(appModule.initialState, { type: 'READY', convId: 'tab-1' });

    // The flag still flips — it drives the composer placeholder — but a warm
    // pool resolves in milliseconds and has nothing to report.
    expect(ready.backendReady).toBe(true);
    expect(ready.messagesById['tab-1'] ?? []).toEqual([]);
  });

  it('does not reply to a start announcement a second time', () => {
    const starting = appModule.reducer(appModule.initialState, {
      type: 'BACKEND_STARTING',
      convId: 'tab-1',
      message: 'Starting backend, please wait…',
    });
    const ready = appModule.reducer(starting, { type: 'READY', convId: 'tab-1' });
    const readyAgain = appModule.reducer(ready, { type: 'READY', convId: 'tab-1' });

    expect(readyAgain.messagesById['tab-1']).toHaveLength(2);
  });

  it('lets a failed start close its own announcement', () => {
    const starting = appModule.reducer(appModule.initialState, {
      type: 'BACKEND_STARTING',
      convId: 'tab-1',
      message: 'Starting backend, please wait…',
    });
    const failed = appModule.reducer(starting, {
      type: 'BACKEND_DOWN',
      convId: 'tab-1',
      message: 'Backend failed to start: llama-server exited with code 1',
    });
    const ready = appModule.reducer(failed, { type: 'READY', convId: 'tab-1' });

    // READY sweeps the failure row; it must not also append a reply to an
    // announcement the failure already answered.
    expect(ready.messagesById['tab-1']?.map((m) => m.content)).toEqual([
      'Starting backend, please wait…',
    ]);
  });

  it('keeps start announcements per conversation', () => {
    const starting = appModule.reducer(appModule.initialState, {
      type: 'BACKEND_STARTING',
      convId: 'tab-1',
      message: 'Starting backend, please wait…',
    });
    const otherReady = appModule.reducer(starting, { type: 'READY', convId: 'tab-2' });

    expect(otherReady.messagesById['tab-2'] ?? []).toEqual([]);
    expect(otherReady.messagesById['tab-1']).toHaveLength(1);
  });

});
