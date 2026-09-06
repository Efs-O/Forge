import { describe, expect, it } from 'vitest';
import { nudgeTruncatedResults } from '../../src/agent/truncatedResultNudge';
import type { ChatMessage } from '../../src/llm/types';

function result(id: string, name: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, name, content };
}

describe('nudgeTruncatedResults', () => {
  it('nudges a truncated search_code result to narrow, not re-run', () => {
    const messages: ChatMessage[] = [
      result('a', 'search_code', '=== src/a.ts ===\n> 1: match\n\n[truncated by search_code — showing 60000 of 140000 chars]'),
    ];

    const out = nudgeTruncatedResults(messages);

    expect(out).not.toBe(messages);
    expect(out[0]?.content).toContain('Do not re-run the same search');
    expect(out[0]?.content).toContain('include');
    // The original marker and content are preserved, the nudge is appended.
    expect(out[0]?.content).toContain('[truncated by search_code');
    expect(out[0]?.content).toContain('=== src/a.ts ===');
  });

  it('nudges a truncated find_files result the same way', () => {
    const messages: ChatMessage[] = [
      result('a', 'find_files', 'src/a.ts\n\n[truncated by find_files — showing 24000 of 90000 chars]'),
    ];
    expect(nudgeTruncatedResults(messages)[0]?.content).toContain('Do not re-run the same search');
  });

  it('nudges a truncated read_file result to page, not re-run', () => {
    const messages: ChatMessage[] = [
      result('a', 'read_file', 'line 1\n\n[truncated by read_file — showing 120000 of 400000 chars]'),
    ];
    const out = nudgeTruncatedResults(messages);
    expect(out[0]?.content).toContain('read_tool_result');
    expect(out[0]?.content).not.toContain('Do not re-run the same search');
  });

  it('leaves a non-truncated result untouched and returns the same array', () => {
    const messages: ChatMessage[] = [result('a', 'search_code', '=== src/a.ts ===\n> 1: match')];
    expect(nudgeTruncatedResults(messages)).toBe(messages);
  });

  it('leaves non-tool and non-string messages untouched', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: null, tool_calls: [] },
      result('a', 'read_file', 'no truncation here'),
    ];
    expect(nudgeTruncatedResults(messages)).toBe(messages);
  });

  it('does not mutate the input message object', () => {
    const original = result('a', 'search_code', 'x\n\n[truncated by search_code — showing 1 of 9 chars]');
    const messages: ChatMessage[] = [original];

    const out = nudgeTruncatedResults(messages);

    expect(out).not.toBe(messages);
    expect(original.content).toBe('x\n\n[truncated by search_code — showing 1 of 9 chars]');
    expect(out[0]).not.toBe(original);
  });
});
