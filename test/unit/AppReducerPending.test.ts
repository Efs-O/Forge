import { beforeAll, describe, expect, it } from 'vitest';
import type { Action, State } from '../../webview-ui/src/reducer';

interface ReducerModule {
  initialState: State;
  reducer: (state: State, action: Action) => State;
}

let mod: ReducerModule;

beforeAll(async () => {
  (globalThis as typeof globalThis & { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi =
    () => ({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    });
  mod = (await import('../../webview-ui/src/reducer')) as ReducerModule;
});

const cid = 'tab-1';

function run(actions: Action[], from?: State): State {
  return actions.reduce((state, action) => mod.reducer(state, action), from ?? mod.initialState);
}

function progress(tokens: number, toolCallId = 'call-a'): Action {
  return {
    type: 'TOOL_CALL_PROGRESS',
    convId: cid,
    index: 0,
    toolCallId,
    toolName: 'write_file',
    target: 'matchbox.html',
    tokens,
  };
}

describe('webview App reducer — pending tool calls', () => {
  it('refreshes one entry per call and drops it when the call row lands', () => {
    let state = run([{ type: 'USER_SEND', text: 'go', convId: cid }, progress(10)]);
    const startedAt = state.pendingToolCallsById.get(cid)![0]!.startedAt;
    state = mod.reducer(state, progress(250));
    expect(state.pendingToolCallsById.get(cid)).toEqual([
      {
        index: 0,
        toolCallId: 'call-a',
        toolName: 'write_file',
        target: 'matchbox.html',
        tokens: 250,
        startedAt, // the row's timer keeps counting from the first event
      },
    ]);
    state = mod.reducer(state, {
      type: 'TOOL_ACTIVITY',
      toolName: 'write_file',
      toolCallId: 'call-a',
      detail: 'matchbox.html',
      convId: cid,
    });
    expect(state.pendingToolCallsById.has(cid)).toBe(false);
  });

  // An unmatched id used to drop the oldest call, another call's row (U20-06).
  it('keeps the pending calls when a landed row carries an id none of them has', () => {
    let state = run([{ type: 'USER_SEND', text: 'go', convId: cid }, progress(10, 'call-a')]);
    state = mod.reducer(state, {
      type: 'TOOL_ACTIVITY',
      toolName: 'read_file',
      toolCallId: 'call-b',
      detail: 'other.ts',
      convId: cid,
    });
    expect(state.pendingToolCallsById.get(cid)?.map((c) => c.toolCallId)).toEqual(['call-a']);
  });

  it.each<Action>([
    { type: 'DONE', convId: cid },
    { type: 'ERROR', message: 'boom', convId: cid },
  ])('$type clears every pending call of the conversation', (end) => {
    const state = run([
      { type: 'USER_SEND', text: 'go', convId: cid },
      progress(10, 'call-a'),
      { ...progress(20, 'call-b'), index: 1 } as Action,
      end,
    ]);
    expect(state.pendingToolCallsById.has(cid)).toBe(false);
  });

  it('seals an open thinking span when the model starts writing a call', () => {
    const state = run([
      { type: 'USER_SEND', text: 'go', convId: cid },
      { type: 'REASONING_TOKEN', text: 'plan', convId: cid },
      progress(5),
    ]);
    const last = state.messagesById[cid]!.at(-1)!;
    expect(last.reasoningStartedAt).toBeDefined();
    expect(last.reasoningMs).toBeDefined();
  });
});

describe('webview App reducer — thinking before the answer', () => {
  it('ends the thinking row when answer text starts a new row', () => {
    const state = run([
      { type: 'USER_SEND', text: 'polish it', convId: cid },
      { type: 'REASONING_TOKEN', text: 'plan', convId: cid },
      { type: 'TOKEN', text: 'Polishing it', convId: cid },
    ]);
    const thought = state.messagesById[cid]!.find((m) => m.reasoning === 'plan')!;
    expect(thought.reasoningMs).toBeDefined();
    expect(state.messagesById[cid]!.at(-1)!.content).toBe('Polishing it');
  });
});

describe('pending tool call label', () => {
  it('shows the timer alone while the count is only the opening brace', async () => {
    const { pendingProgressLabel } = await import(
      '../../webview-ui/src/components/PendingToolCallRow'
    );
    expect(pendingProgressLabel(42, 1)).toBe('writing… 42 s');
    expect(pendingProgressLabel(42, 4210)).toBe('writing… 42 s · 4,210 tokens');
  });
});

describe('webview App reducer — stopped turns', () => {
  it('adds one Stopped line when the user stops a streaming turn', () => {
    const stopped = run([
      { type: 'USER_SEND', text: 'go', convId: cid },
      { type: 'TOKEN', text: 'Hel', convId: cid },
      { type: 'DONE', convId: cid, finishReason: 'cancelled' },
      { type: 'DONE', convId: cid, finishReason: 'cancelled' },
    ]);
    const system = stopped.messagesById[cid]!.filter((m) => m.role === 'system');
    expect(system.map((m) => m.content)).toEqual(['Stopped.']);
  });

  it('adds nothing when a turn finishes normally', () => {
    const done = run([
      { type: 'USER_SEND', text: 'go', convId: cid },
      { type: 'TOKEN', text: 'Hi', convId: cid },
      { type: 'DONE', convId: cid, finishReason: 'stop' },
    ]);
    expect(done.messagesById[cid]!.some((m) => m.role === 'system')).toBe(false);
  });
});
