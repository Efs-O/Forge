import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import {
  collectCompactionUserMessages,
  renderCompactionUserMessages,
  USER_CONTEXT_MAX_CHARS,
  USER_CONTEXT_MAX_MESSAGES,
} from '../../src/sidebar/compactionUserContext';

describe('compaction user context', () => {
  it('keeps user-authored decisions but excludes Forge continuation prompts', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'build the workflow' },
      { role: 'user', content: 'Continue the active task.', internal: true },
      { role: 'user', content: 'keep the fixed-camera version' },
    ];

    expect(collectCompactionUserMessages(undefined, messages)).toEqual([
      'build the workflow',
      'keep the fixed-camera version',
    ]);
  });

  it('deduplicates repeated requests across compaction generations', () => {
    const collected = collectCompactionUserMessages(
      ['original request', 'use model A'],
      [
        { role: 'user', content: 'use model A' },
        { role: 'user', content: 'switch to model B' },
      ],
    );

    expect(collected).toEqual(['original request', 'use model A', 'switch to model B']);
    expect(renderCompactionUserMessages(collected)).toContain('[3] switch to model B');
  });

  it('always keeps the original request and fills bounded room newest-first', () => {
    const messages: ChatMessage[] = Array.from({ length: 40 }, (_, index) => ({
      role: 'user' as const,
      content: `${index}: ${'x'.repeat(600)}`,
    }));

    const collected = collectCompactionUserMessages(undefined, messages);
    expect(collected[0]).toContain('0:');
    expect(collected.at(-1)).toContain('39:');
    expect(collected.length).toBeLessThanOrEqual(USER_CONTEXT_MAX_MESSAGES);
    expect(collected.reduce((sum, message) => sum + message.length, 0)).toBeLessThanOrEqual(
      USER_CONTEXT_MAX_CHARS,
    );
  });
});
