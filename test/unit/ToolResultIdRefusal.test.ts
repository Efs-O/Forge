import { describe, expect, it } from 'vitest';
import { makeReadToolResultTool } from '../../src/tools/toolResultTools';
import type { ChatMessage } from '../../src/llm/types';

/**
 * One session asked `read_tool_result` for a background execution id, got a bare
 * "no text tool result with call ID … exists in this conversation", and retried.
 * The refusal now names the other kind of id, the search that still works, and
 * the way back when neither does.
 */
const messages: ChatMessage[] = [
  { role: 'assistant', content: 'I will run it' },
  { role: 'tool', tool_call_id: 'call-live', content: 'the live result text' },
];
const context = { beforeMutate: () => undefined, conversationMessages: messages };

describe('a tool_call_id that misses', () => {
  it('names the tool that lists execution ids, and the query mode that searches', async () => {
    const tool = makeReadToolResultTool();
    const missed = (await tool.handler(
      { tool_call_id: 'exec-bb3a0b1c' },
      context,
    )) as unknown as string;
    expect(missed).toMatch(/^Error: no text tool result with call ID "exec-bb3a0b1c"/);
    expect(missed).toMatch(/list_executions/);
    expect(missed).toMatch(/`query`/);
    expect(missed).toMatch(/re-run/);
  });

  it('still returns the text when the id is one that exists', async () => {
    const tool = makeReadToolResultTool();
    const hit = (await tool.handler({ tool_call_id: 'call-live' }, context)) as unknown as string;
    expect(hit).toContain('the live result text');
  });
});
