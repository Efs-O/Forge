import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolCall } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';
import {
  BROKEN_TOOL_CALL_NUDGE,
  isBrokenToolCallAnswer,
  nudgeBrokenToolCall,
} from '../../src/agent/brokenToolCallMarkup';

interface Handlers {
  onToken: (t: string) => void;
  onReasoning: (t: string) => void;
  onDone: (finishReason: string | null) => void;
  onToolCalls: (calls: ToolCall[]) => void;
}

const CALL: ToolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'read_file', arguments: '{}' },
};

/** Session 86b15ced: the model's whole final message, with no function name. */
const BROKEN_ANSWER = [
  '<tool_call>',
  '<= put the new module in a file, then edit the tool family to use it>',
  '</parameter=',
  '</function>',
  '</tool_call>',
].join('\n');

const SECOND_BROKEN = ['<tool_call>', '{"name": }', '</tool_call>'].join('\n');

function runOptions(messages: ChatMessage[]) {
  return {
    resolveBaseUrl: async () => 'http://localhost:0',
    model: { name: 'test-model' } as never,
    messages,
    getToolDefinitions: () => [{ type: 'function', function: { name: 'read_file' } }] as never,
    dispatchToolCalls: async (calls: ToolCall[], msgs: ChatMessage[]) => {
      for (const c of calls) {
        msgs.push({ role: 'tool', content: 'file contents', tool_call_id: c.id, name: 'read_file' });
      }
    },
    signal: new AbortController().signal,
    maxRounds: 5,
    nativeTools: true,
  };
}

/** Answers with `text` and stops, calls read_file, or answers `final answer`. */
function scriptRounds(...answers: (string | 'call' | 'final answer')[]) {
  const requests: ChatMessage[][] = [];
  let round = 0;
  streamModelChatCompletion.mockImplementation(
    async (_url: string, request: { messages: ChatMessage[] }, _model: unknown, h: Handlers) => {
      requests.push(request.messages.map((message) => ({ ...message })));
      round += 1;
      const answer = answers[round - 1] ?? 'final answer';
      if (answer === 'call') {
        h.onToolCalls([CALL]);
        h.onDone('tool_calls');
      } else {
        h.onToken(answer);
        h.onDone('stop');
      }
    },
  );
  return requests;
}

describe('isBrokenToolCallAnswer', () => {
  it('flags an answer that is only tool-call markup', () => {
    expect(isBrokenToolCallAnswer(BROKEN_ANSWER)).toBe(true);
    expect(isBrokenToolCallAnswer('<function=edit_file>\n<parameter=path>a.ts')).toBe(true);
    expect(isBrokenToolCallAnswer('Now I will edit it.\n<tool_call>\n{"name": }\n</tool_call>')).toBe(
      true,
    );
  });

  it('leaves an answer that merely mentions the markup alone', () => {
    expect(isBrokenToolCallAnswer('Qwen emits `<tool_call>` tags around each call.')).toBe(false);
    expect(isBrokenToolCallAnswer('Done. The parser now handles </function> correctly.')).toBe(
      false,
    );
    expect(isBrokenToolCallAnswer('')).toBe(false);
  });
});

describe('nudgeBrokenToolCall', () => {
  it('pushes the nudge once and reports the retry', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    expect(nudgeBrokenToolCall(messages, BROKEN_ANSWER)).toBe(true);
    expect(messages[1]).toEqual({ role: 'user', content: BROKEN_TOOL_CALL_NUDGE, internal: true });
    expect(nudgeBrokenToolCall(messages, BROKEN_ANSWER)).toBe(false);
    expect(messages).toHaveLength(2);
  });

  it('sends nothing for an ordinary final answer', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    expect(nudgeBrokenToolCall(messages, 'Done. The parser now handles </function> correctly.')).toBe(
      false,
    );
    expect(messages).toHaveLength(1);
  });

  it('reserves a fresh retry once a tool result lands', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: BROKEN_TOOL_CALL_NUDGE, internal: true },
      { role: 'assistant', content: BROKEN_ANSWER, createdAt: 1 },
      { role: 'tool', content: 'file contents', tool_call_id: 'call_1', name: 'read_file' },
      { role: 'assistant', content: BROKEN_ANSWER, createdAt: 2 },
    ];
    expect(nudgeBrokenToolCall(messages, BROKEN_ANSWER)).toBe(true);
  });

  // The text the model is asked with; a rewrite here is a rewrite of the rule.
  it('nudges with the published sentence', () => {
    expect(BROKEN_TOOL_CALL_NUDGE).toBe(
      "Your last message was tool-call markup that did not parse into a call, so nothing ran. Make the tool call again through the tool-calling interface, with the tool's name and its JSON arguments, or answer in plain text if you are done.",
    );
  });
});

describe('ToolCallingLoop broken tool-call markup', () => {
  beforeEach(() => {
    streamModelChatCompletion.mockReset();
  });

  it('nudges once and keeps working when the answer is unparsed markup', async () => {
    const requests = scriptRounds(BROKEN_ANSWER, 'call', 'final answer');
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];

    const result = await runToolCallingLoop(runOptions(messages) as never);

    expect(streamModelChatCompletion).toHaveBeenCalledTimes(3);
    expect(messages).toContainEqual({
      role: 'user',
      content: BROKEN_TOOL_CALL_NUDGE,
      internal: true,
    });
    // The model saw the nudge before it was asked again.
    expect(requests[2]).toContainEqual({
      role: 'user',
      content: BROKEN_TOOL_CALL_NUDGE,
      internal: true,
    });
    // The broken markup is on the transcript as the round's answer.
    expect(messages[1]).toMatchObject({ role: 'assistant', content: BROKEN_ANSWER });
    expect(result.finalText).toBe('final answer');
  });

  it('ends the turn when the one nudge did not help', async () => {
    scriptRounds(BROKEN_ANSWER, SECOND_BROKEN);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];

    const result = await runToolCallingLoop(runOptions(messages) as never);

    expect(streamModelChatCompletion).toHaveBeenCalledTimes(2);
    expect(messages.filter((message) => message.content === BROKEN_TOOL_CALL_NUDGE)).toHaveLength(1);
    expect(result.finalText).toBe(SECOND_BROKEN);
  });

  it('nudges again after real tool calls, so the retry cannot go stale', async () => {
    scriptRounds(BROKEN_ANSWER, 'call', SECOND_BROKEN, 'done');
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];

    const result = await runToolCallingLoop(runOptions(messages) as never);

    expect(streamModelChatCompletion).toHaveBeenCalledTimes(4);
    expect(messages.filter((message) => message.content === BROKEN_TOOL_CALL_NUDGE)).toHaveLength(2);
    expect(result.finalText).toBe('done');
  });
});
