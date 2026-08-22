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

describe('webview App reducer — transcript rows', () => {
  describe('tool rows', () => {
    it('fills the pending activity row in place instead of adding a second row', () => {
      const started = appModule.reducer(appModule.initialState, {
        type: 'TOOL_ACTIVITY',
        toolName: 'codex',
        detail: 'starting',
        convId: 'tab-1',
      });
      const finished = appModule.reducer(started, {
        type: 'TOOL_RESULT',
        toolName: 'codex',
        label: 'Summary line',
        text: 'the full report',
        totalChars: 3100,
        convId: 'tab-1',
      });

      const rows = finished.messagesById['tab-1']!.filter((m) => m.role === 'tool');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.content).toBe('codex → Summary line');
      expect(rows[0]!.toolResult).toBe('the full report');
    });

    it('appends a row when no activity row is pending', () => {
      const only = appModule.reducer(appModule.initialState, {
        type: 'TOOL_RESULT',
        toolName: 'read_file',
        label: 'src/a.ts',
        text: 'contents',
        totalChars: 8,
        convId: 'tab-1',
      });

      expect(only.messagesById['tab-1']!.filter((m) => m.role === 'tool')).toHaveLength(1);
    });

    it('does not fill one tool call with another tool result', () => {
      let state = appModule.reducer(appModule.initialState, {
        type: 'TOOL_ACTIVITY',
        toolName: 'read_file',
        convId: 'tab-1',
      });
      state = appModule.reducer(state, {
        type: 'TOOL_RESULT',
        toolName: 'write_file',
        label: 'src/b.ts',
        text: 'written',
        totalChars: 7,
        convId: 'tab-1',
      });

      const rows = state.messagesById['tab-1']!.filter((m) => m.role === 'tool');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.toolResult).toBeUndefined();
    });
  });

  it('keeps streamed reasoning separate when final answer tokens arrive', () => {
    const thinking = appModule.reducer(appModule.initialState, {
      type: 'REASONING_TOKEN',
      text: 'Checking the workspace.',
      convId: 'tab-1',
    });
    const answer = appModule.reducer(thinking, {
      type: 'TOKEN',
      text: 'Done.',
      convId: 'tab-1',
    });

    expect(answer.messagesById['tab-1']).toMatchObject([
      { role: 'assistant', content: '', reasoning: 'Checking the workspace.' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('does not replace live reasoning with a stale session snapshot', () => {
    let state = appModule.reducer(appModule.initialState, {
      type: 'GENERATION_STARTED',
      convId: 'tab-1',
    });
    state = appModule.reducer(state, {
      type: 'REASONING_TOKEN',
      text: 'A long trace that is still streaming.',
      convId: 'tab-1',
    });
    const live = state.messagesById['tab-1']![0]!;

    state = appModule.reducer(state, {
      type: 'SESSION_SYNC',
      activeId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'Chat',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 0,
          streaming: true,
        },
      ],
      history: [],
      // This snapshot was created before the latest reasoning tokens arrived.
      messagesById: { 'tab-1': [] },
    });

    expect(state.messagesById['tab-1']).toEqual([live]);
  });

  describe('checkpoint bar visibility', () => {
    function pendingIn(state: AppModule['initialState'], convId: string): boolean {
      return appModule.selectCheckpointPending({ ...state, activeConversationId: convId });
    }

    it('shows the bar only in the conversation that produced the checkpoint', () => {
      const ready = appModule.reducer(appModule.initialState, {
        type: 'CHECKPOINT_READY',
        convId: 'tab-1',
      });

      expect(pendingIn(ready, 'tab-1')).toBe(true);
      expect(pendingIn(ready, 'tab-2')).toBe(false);
    });

    it('keeps the bar pending in its own tab while another tab is active', () => {
      const ready = appModule.reducer(appModule.initialState, {
        type: 'CHECKPOINT_READY',
        convId: 'tab-1',
      });
      // Sending in a second tab must not dismiss the first tab's pending checkpoint.
      const otherTurn = appModule.reducer(ready, {
        type: 'USER_SEND',
        convId: 'tab-2',
        text: 'unrelated work',
      });

      expect(pendingIn(otherTurn, 'tab-1')).toBe(true);
      expect(pendingIn(otherTurn, 'tab-2')).toBe(false);
    });

    it('dismisses only the named conversation', () => {
      let state = appModule.reducer(appModule.initialState, {
        type: 'CHECKPOINT_READY',
        convId: 'tab-1',
      });
      state = appModule.reducer(state, { type: 'CHECKPOINT_READY', convId: 'tab-2' });
      state = appModule.reducer(state, { type: 'CHECKPOINT_DISMISSED', convId: 'tab-1' });

      expect(pendingIn(state, 'tab-1')).toBe(false);
      expect(pendingIn(state, 'tab-2')).toBe(true);
    });

    it('clears the pending checkpoint when a new turn starts in the same tab', () => {
      const ready = appModule.reducer(appModule.initialState, {
        type: 'CHECKPOINT_READY',
        convId: 'tab-1',
      });
      const nextTurn = appModule.reducer(ready, {
        type: 'USER_SEND',
        convId: 'tab-1',
        text: 'next',
      });

      expect(pendingIn(nextTurn, 'tab-1')).toBe(false);
    });

    it('drops pending ids for closed tabs but never for the active one', () => {
      let state = appModule.reducer(appModule.initialState, {
        type: 'CHECKPOINT_READY',
        convId: 'tab-1',
      });
      state = appModule.reducer(state, { type: 'CHECKPOINT_READY', convId: 'tab-2' });
      const synced = appModule.reducer(state, {
        type: 'SESSION_SYNC',
        activeId: 'tab-1',
        tabs: [{ id: 'tab-1', title: 'Chat', createdAt: 1, updatedAt: 2, messageCount: 1 }],
        history: [],
        messagesById: { 'tab-1': [{ role: 'user', content: 'hello' }] },
      });

      expect(pendingIn(synced, 'tab-1')).toBe(true);
      expect(pendingIn(synced, 'tab-2')).toBe(false);
    });
  });
});
