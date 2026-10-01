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

  it('searches pre-compaction user, assistant, and tool text newest first', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Earlier Needle request.' },
      { role: 'assistant', content: 'Earlier Needle answer.' },
      {
        role: 'tool',
        tool_call_id: 'needle-tool-id',
        name: 'exec_command',
        content: [{ type: 'text', text: 'Earlier Needle output.' }],
      },
      { role: 'user', content: 'After the cut.' },
    ];
    const result = await makeReadToolResultTool().handler(
      { query: 'needle' },
      { beforeMutate: () => undefined, conversationMessages: messages },
    );
    expect(result).toContain('message_index 2, tool_call_id "needle-tool-id"');
    expect(result).toContain('message_index 1');
    expect(result).toContain('message_index 0');
    expect(result.indexOf('message_index 2')).toBeLessThan(result.indexOf('message_index 1'));
    expect(result.indexOf('message_index 1')).toBeLessThan(result.indexOf('message_index 0'));
    expect(result).toContain('character offset 8');
  });

  it('reports offsets in the original text when case folding expands a character', async () => {
    const result = await makeReadToolResultTool().handler(
      { query: 'needle' },
      {
        beforeMutate: () => undefined,
        conversationMessages: [{ role: 'user', content: 'İ needle' }],
      },
    );
    expect(result).toContain('character offset 2');
  });

  it('reads exact user and assistant messages and directs tool rows to their ID', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'User message body.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Assistant message body.' }] },
      { role: 'tool', tool_call_id: 'exact-tool-id', name: 'read_file', content: 'tool output' },
    ];
    const tool = makeReadToolResultTool();
    const user = await tool.handler(
      { message_index: 0, offset: 5, max_chars: 9 },
      { beforeMutate: () => undefined, conversationMessages: messages },
    );
    const assistant = await tool.handler(
      { message_index: 1 },
      { beforeMutate: () => undefined, conversationMessages: messages },
    );
    const toolRow = await tool.handler(
      { message_index: 2 },
      { beforeMutate: () => undefined, conversationMessages: messages },
    );
    expect(user).toContain('Message 0 (user)');
    expect(user).toContain('message b');
    expect(assistant).toContain('Assistant message body.');
    expect(toolRow).toContain('tool_call_id "exact-tool-id"');
  });

  it('returns actionable validation errors naming all three modes', async () => {
    const tool = makeReadToolResultTool();
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const invoke = (args: Record<string, unknown>) =>
      tool.handler(args, { beforeMutate: () => undefined, conversationMessages: messages });
    for (const args of [{}, { tool_call_id: 'x', query: 'xx' }, { query: 'x' }, { message_index: 9 }]) {
      const error = await invoke(args);
      expect(error).toContain('tool_call_id');
      expect(error).toContain('query');
      expect(error).toContain('message_index');
    }
    expect(await invoke({})).toContain('Received 0 modes');
    expect(await invoke({ tool_call_id: 'x', query: 'xx' })).toContain('Received 2 modes');
    expect(await invoke({ query: 'x' })).toContain('between 2 and 200');
    expect(await invoke({ message_index: 9 })).toContain('outside this conversation');
  });

  it('caps search output and reports how many matches were omitted', async () => {
    const messages: ChatMessage[] = Array.from({ length: 50 }, (_, index) => ({
      role: 'user' as const,
      content: `needle-${index} ${'context '.repeat(60)}`,
    }));
    const result = await makeReadToolResultTool().handler(
      { query: 'needle', max_matches: 10 },
      { beforeMutate: () => undefined, conversationMessages: messages },
    );
    expect(result.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_READ_CHARS);
    expect(result).toContain('40 of 50 matching messages not shown');
    expect(result).toContain('use a narrower query');
    expect(result).toContain('message_index 49');
    expect(result).not.toContain('message_index 39');
  });

  it('does not search reasoning or internal messages and names exact modes on no match', async () => {
    const result = await makeReadToolResultTool().handler(
      { query: 'secret' },
      {
        beforeMutate: () => undefined,
        conversationMessages: [
          { role: 'assistant', content: 'ordinary content', reasoning: 'secret reasoning' },
          { role: 'user', content: 'secret internal', internal: true },
        ],
      },
    );
    expect(result).toContain('No matches');
    expect(result).toContain('tool_call_id');
    expect(result).toContain('message_index');
    expect(result).not.toContain('secret reasoning');
    expect(result).not.toContain('secret internal');
  });

  it('keeps the expanded tool definition within the 600-character growth budget', () => {
    expect(JSON.stringify(makeReadToolResultTool().definition).length).toBeLessThanOrEqual(617 + 600);
  });
});

describe('tool-loop context preflight', () => {
  it('does not dispatch a request when the prepared prompt has no usable output room', async () => {
    let called = false;
    await expect(
      runToolCallingLoop({
        resolveBaseUrl: async () => 'http://localhost:0',
        model: { name: 'local' } as never,
        messages: [{ role: 'user', content: 'x' }],
        getToolDefinitions: () => [],
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
