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

  it('resolves a unique truncated call ID and returns the canonical ID', async () => {
    const tool = makeReadToolResultTool();
    expect(await tool.handler({ tool_call_id: 'call-liv' }, context)).toBe(
      'Tool result call-live, chars 0-20 of 20:\nthe live result text',
    );
  });

  it('answers a tool NAME with that tool\'s most recent result, naming the id', async () => {
    // Session cf3c7470-749c-4de5-b7ff-f4de886edc62.jsonl row 372: the model had
    // just read code with read_file and asked for `{"tool_call_id":"read_file"}`
    // — the name is the handle it has, not an id.
    const named: ChatMessage[] = [
      { role: 'tool', name: 'read_file', tool_call_id: 'call-old', content: 'first file text' },
      { role: 'tool', name: 'read_file', tool_call_id: 'call-new', content: 'second file text' },
      { role: 'tool', name: 'shell', tool_call_id: 'call-shell', content: 'exit 0' },
    ];
    const tool = makeReadToolResultTool();

    expect(
      await tool.handler(
        { tool_call_id: 'read_file' },
        { beforeMutate: () => undefined, conversationMessages: named },
      ),
    ).toBe(
      'Tool result call-new (the most recent read_file result), chars 0-16 of 16:\nsecond file text',
    );
  });

  it('refuses a tool name that produced no text result here', async () => {
    const tool = makeReadToolResultTool();
    const missed = String(
      await tool.handler(
        { tool_call_id: 'grep_search' },
        { beforeMutate: () => undefined, conversationMessages: messages },
      ),
    );
    expect(missed).toMatch(/^Error: no text tool result with call ID "grep_search"/u);
  });
});

describe('read_tool_result shape recovery', () => {
  it('reads the tool result named by message_index without a second lookup call', async () => {
    const tool = makeReadToolResultTool();
    expect(await tool.handler({ message_index: 1 }, context)).toBe(
      'Tool result call-live, chars 0-20 of 20:\nthe live result text',
    );
  });

  it('uses query when the model also supplies message_index as a search scope', async () => {
    const tool = makeReadToolResultTool();
    expect(await tool.handler({ query: 'live result', message_index: 1 }, context)).toBe(
      'Search results for "live result" (newest first):\n' +
        '[tool message_index 1, tool_call_id "call-live", character offset 4]\n' +
        'the live result text',
    );
  });

  it('caps an oversized max_matches request at ten results', async () => {
    const manyMessages: ChatMessage[] = Array.from({ length: 11 }, (_unused, index) => ({
      role: 'tool',
      tool_call_id: `call-${index}`,
      content: 'needle',
    }));
    const tool = makeReadToolResultTool();
    const result = String(
      await tool.handler(
        { query: 'needle', max_matches: 20 },
        { beforeMutate: () => undefined, conversationMessages: manyMessages },
      ),
    );
    expect(result).not.toMatch(/^Error:/u);
    expect(result).toContain('1 of 11 matching messages not shown');
    expect(result).toContain('message_index 1');
    expect(result).not.toContain('message_index 0');
  });

  it('states the full search modes and that message_index includes tool results', () => {
    const fn = makeReadToolResultTool().definition.function;
    expect(fn.description).toBe(
      'Search and read earlier text in this conversation, including messages before a compaction. Use exactly one mode: query (literal search), tool_call_id (exact or unique-prefix ID), or message_index (any message or tool row by its zero-based index).',
    );
    expect(fn.parameters?.properties['max_matches']?.description).toBe(
      'Search result limit (1 to 10); defaults to 6.',
    );
    expect(fn.parameters?.properties['tool_call_id']?.description).toBe(
      'Tool-result mode: exact ID, unique prefix (8+ characters), or a tool name — its latest result is read.',
    );
    expect(fn.parameters?.properties['message_index']?.description).toBe(
      'Exact-message mode: zero-based conversation message index, including tool results.',
    );
  });
});
