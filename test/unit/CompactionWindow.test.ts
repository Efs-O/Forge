import { describe, expect, it } from 'vitest';
import { applyCompactionWindow, SUMMARY_PREAMBLE } from '../../src/sidebar/compactionWindow';
import type { ChatMessage } from '../../src/llm/types';

const transcript = (): ChatMessage[] => [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second question' },
  { role: 'assistant', content: 'second answer' },
];

describe('applyCompactionWindow', () => {
  it('returns the transcript untouched when nothing is compacted', () => {
    const msgs = transcript();
    expect(applyCompactionWindow(msgs, undefined)).toEqual(msgs);
  });

  // The whole point: the model sees less, the stored transcript is not altered.
  it('sends summary + tail without mutating the input', () => {
    const msgs = transcript();
    const before = JSON.parse(JSON.stringify(msgs)) as ChatMessage[];

    const out = applyCompactionWindow(msgs, { summary: 'we did X', fromIndex: 2 });

    expect(out).toEqual([
      { role: 'user', content: SUMMARY_PREAMBLE },
      { role: 'assistant', content: 'we did X' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ]);
    expect(msgs).toEqual(before);
  });

  it('compacting everything still leaves a usable two-message context', () => {
    const msgs = transcript();
    expect(applyCompactionWindow(msgs, { summary: 's', fromIndex: msgs.length })).toEqual([
      { role: 'user', content: SUMMARY_PREAMBLE },
      { role: 'assistant', content: 's' },
    ]);
  });

  // A tool result whose tool_calls turn was cut away references a tool_call_id
  // the model never saw, which providers reject.
  it('drops tool results orphaned by the cut', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [] as never },
      { role: 'tool', content: 'orphaned result', tool_call_id: 'call_1' },
      { role: 'tool', content: 'also orphaned', tool_call_id: 'call_2' },
      { role: 'assistant', content: 'done' },
    ];
    const out = applyCompactionWindow(msgs, { summary: 's', fromIndex: 2 });
    expect(out.some((m) => m.role === 'tool')).toBe(false);
    expect(out[out.length - 1]).toEqual({ role: 'assistant', content: 'done' });
  });

  it('clamps an out-of-range cut point', () => {
    const msgs = transcript();
    expect(applyCompactionWindow(msgs, { summary: 's', fromIndex: 999 })).toHaveLength(2);
    expect(applyCompactionWindow(msgs, { summary: 's', fromIndex: -5 })).toHaveLength(
      msgs.length + 2,
    );
  });
});
