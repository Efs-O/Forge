import { describe, expect, it } from 'vitest';
import { reducer } from '../../webview-ui/src/reducer';
import { initialState } from '../../webview-ui/src/appState';

describe('tool result pairing', () => {
  it('updates the row with the matching tool-call id when parallel results arrive out of order', () => {
    let state = reducer(initialState, {
      type: 'TOOL_ACTIVITY',
      convId: 'chat',
      toolName: 'shell',
      toolCallId: 'shell-call',
      detail: 'npm test',
    });
    state = reducer(state, {
      type: 'TOOL_ACTIVITY',
      convId: 'chat',
      toolName: 'web_fetch',
      toolCallId: 'fetch-call',
      detail: 'https://a.example/',
    });
    state = reducer(state, {
      type: 'TOOL_RESULT',
      convId: 'chat',
      toolName: 'web_fetch',
      toolCallId: 'fetch-call',
      label: 'declined',
      text: 'Error: User declined: web_fetch',
      totalChars: 31,
      isError: true,
    });
    state = reducer(state, {
      type: 'TOOL_RESULT',
      convId: 'chat',
      toolName: 'shell',
      toolCallId: 'shell-call',
      label: 'exit 0',
      text: 'exit 0',
      totalChars: 6,
    });

    const rows = state.messagesById.chat ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.toolCallId === 'shell-call')?.toolResult).toBe('exit 0');
    expect(rows.find((row) => row.toolCallId === 'fetch-call')).toMatchObject({
      toolResult: 'Error: User declined: web_fetch',
      toolIsError: true,
    });
  });

  it('does not assign an identified result to an unidentified pending row', () => {
    const state = reducer(initialState, {
      type: 'TOOL_ACTIVITY',
      convId: 'chat',
      toolName: 'shell',
    });
    const next = reducer(state, {
      type: 'TOOL_RESULT',
      convId: 'chat',
      toolName: 'shell',
      toolCallId: 'unknown-call',
      label: 'result',
      text: 'result',
      totalChars: 6,
    });

    expect(next.messagesById.chat).toHaveLength(2);
    expect(next.messagesById.chat?.[0]?.toolResult).toBeUndefined();
    expect(next.messagesById.chat?.[1]?.toolCallId).toBe('unknown-call');
  });
});
