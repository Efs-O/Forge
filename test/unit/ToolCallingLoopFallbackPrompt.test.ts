import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, ChatMessage } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';

interface Handlers {
  onToken: (t: string) => void;
  onDone: (finishReason: string | null) => void;
}

/** Answers once and records every request the loop sent. */
function captureRequests(): ChatCompletionRequest[] {
  const sent: ChatCompletionRequest[] = [];
  streamModelChatCompletion.mockImplementation(
    async (_url: string, req: ChatCompletionRequest, _model: unknown, h: Handlers) => {
      sent.push(req);
      h.onToken('answer');
      h.onDone('stop');
    },
  );
  return sent;
}

function runOptions(messages: ChatMessage[], extra: { nativeTools: boolean; stripAllTools?: boolean }) {
  return {
    resolveBaseUrl: async () => 'http://localhost:0',
    model: { name: 'test-model' } as never,
    messages,
    getToolDefinitions: () => [{ type: 'function', function: { name: 'read_file' } }] as never,
    dispatchToolCalls: async () => undefined,
    signal: new AbortController().signal,
    maxRounds: 3,
    ...extra,
  };
}

const HISTORY: ChatMessage[] = [
  { role: 'system', content: 'you are forge' },
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'done' },
  { role: 'user', content: 'second' },
];

// Qwen's chat template raises "System message must be at the beginning" on any
// system message after index 0. The fallback catalog used to be appended as a
// trailing system message, so once ToolFailureTracker switched a session to
// strip mode every later turn in that chat failed with HTTP 500.
describe('ToolCallingLoop fallback tool prompt', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  it('keeps the only system message at index 0 in strip mode', async () => {
    const sent = captureRequests();
    await runToolCallingLoop(
      runOptions([...HISTORY], { nativeTools: true, stripAllTools: true }) as never,
    );
    const req = sent[0];
    expect(req?.tools).toBeUndefined();
    expect(req?.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    // Strip mode is a recovery path: the model still calls tools as fenced JSON.
    expect(String(req?.messages[0]?.content)).toContain('Native tool calling is unavailable');
  });

  it('merges the fallback catalog into the leading system message', async () => {
    const sent = captureRequests();
    await runToolCallingLoop(runOptions([...HISTORY], { nativeTools: false }) as never);
    const msgs = sent[0]?.messages ?? [];
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(String(msgs[0]?.content)).toContain('you are forge');
    expect(String(msgs[0]?.content)).toContain('Native tool calling is unavailable');
  });

  it('prepends a system message when the history has none', async () => {
    const sent = captureRequests();
    await runToolCallingLoop(
      runOptions([{ role: 'user', content: 'go' }], { nativeTools: false }) as never,
    );
    const msgs = sent[0]?.messages ?? [];
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(String(msgs[0]?.content)).toContain('Native tool calling is unavailable');
  });
});
