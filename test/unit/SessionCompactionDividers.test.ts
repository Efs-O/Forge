import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import { displayTranscriptRows } from '../../src/sidebar/sessionProjections';

describe('compaction transcript dividers', () => {
  it('places every generation at its persisted fromIndex boundary', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'first result' },
      { role: 'user', content: 'second task' },
      { role: 'assistant', content: 'second result' },
    ];

    const rows = displayTranscriptRows(messages, [], {
      summary: 'second result is complete',
      fromIndex: 4,
      generation: 2,
      dividers: [
        { generation: 1, fromIndex: 2, source: 'auto' },
        { generation: 2, fromIndex: 4, source: 'manual' },
      ],
    });

    expect(rows.map((row) => row.role)).toEqual([
      'user',
      'assistant',
      'compaction',
      'user',
      'assistant',
      'compaction',
    ]);
    expect(rows.filter((row) => row.role === 'compaction')).toEqual([
      { role: 'compaction', content: 'Context compacted', generation: 1, source: 'auto' },
      { role: 'compaction', content: 'Context compacted', generation: 2, source: 'manual' },
    ]);
  });

  it('derives a divider for legacy state that has only the current compaction', () => {
    const rows = displayTranscriptRows(
      [
        { role: 'user', content: 'first task' },
        { role: 'assistant', content: 'first result' },
      ],
      [],
      { summary: 'first result', fromIndex: 2, generation: 3 },
    );

    expect(rows.at(-1)).toEqual({
      role: 'compaction',
      content: 'Context compacted',
      generation: 3,
    });
  });
});
