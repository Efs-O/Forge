import { describe, expect, it } from 'vitest';
import { prepareToolResultContext } from '../../src/agent/toolResultContext';
import { CONTEXT_INPUT_EXHAUSTED_MESSAGE, runToolCallingLoop } from '../../src/agent/ToolCallingLoop';
import type { ChatMessage } from '../../src/llm/types';
import { makeReadToolResultTool, MAX_TOOL_RESULT_READ_CHARS } from '../../src/tools/toolResultTools';

const model = { name: 'local', num_ctx: 12_000 } as never;

function longResult(): string {
  return `START FACT\n${'diagnostic line\n'.repeat(8_000)}END FACT`;
}

describe('loss-aware tool-result context', () => {
  it('keeps raw transcript data while reducing only the model copy', () => {
    const raw = longResult();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Investigate the failure.' },
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'large', type: 'function', function: { name: 'run_tests', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'large', name: 'run_tests', content: raw },
      { role: 'user', content: 'Continue.' },
    ];

    const result = prepareToolResultContext({ messages, toolTokens: 0, model });

    expect(result.fits).toBe(true);
    expect(result.excerptedToolCallIds).toEqual(['large']);
    expect(messages[2]?.content).toBe(raw);
    expect(result.messages[2]?.content).not.toBe(raw);
    expect(result.messages[2]?.content).toContain('START FACT');
    expect(result.messages[2]?.content).toContain('END FACT');
    expect(result.messages[2]?.content).toContain('read_tool_result');
  });

  it('does not alter a prompt that already fits', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'small request' }];
    const result = prepareToolResultContext({ messages, toolTokens: 0, model });
    expect(result.messages).toBe(messages);
    expect(result.excerptedToolCallIds).toEqual([]);
  });
});

describe('read_tool_result', () => {
  it('returns an exact bounded range from the current conversation only', async () => {
    const raw = Array.from(
      { length: 1_000 },
      (_, index) => `line-${index.toString().padStart(5, '0')}\n`,
    ).join('');
    const tool = makeReadToolResultTool();
    const result = await tool.handler(
      { tool_call_id: 'old', offset: 123, max_chars: MAX_TOOL_RESULT_READ_CHARS + 1 },
      {
        beforeMutate: () => undefined,
        conversationMessages: [{ role: 'tool', tool_call_id: 'old', name: 'run_tests', content: raw }],
      },
    );
    expect(result).toContain(raw.slice(123, 123 + MAX_TOOL_RESULT_READ_CHARS));
    expect(result).not.toContain(raw.slice(123 + MAX_TOOL_RESULT_READ_CHARS));
  });

  it('does not expose a result from another conversation', async () => {
    const result = await makeReadToolResultTool().handler(
      { tool_call_id: 'missing' },
      { beforeMutate: () => undefined, conversationMessages: [] },
    );
    expect(result).toContain('no text tool result');
  });
});

describe('tool-loop context preflight', () => {
  it('does not dispatch a request when the prepared prompt has no usable output room', async () => {
    let called = false;
    await expect(
      runToolCallingLoop({
        baseUrl: 'http://localhost:0',
        model: { name: 'local' } as never,
        messages: [{ role: 'user', content: 'x' }],
        toolDefinitions: [],
        dispatchToolCalls: async () => undefined,
        signal: new AbortController().signal,
        maxRounds: 1,
        nativeTools: true,
        getOutputRoom: () => 0,
        onToken: () => { called = true; },
      }),
    ).rejects.toThrow(CONTEXT_INPUT_EXHAUSTED_MESSAGE);
    expect(called).toBe(false);
  });
});
