import { describe, it, expect } from 'vitest';
import { applyToolCalls } from '../../src/sidebar/transcriptMutations';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

function conv(): ConversationRuntime {
  return {
    id: 'c1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    messages: [],
  } as unknown as ConversationRuntime;
}

describe('applyToolCalls', () => {
  it('starts from absent, not zero, so old sessions do not claim a count', () => {
    const c = conv();
    expect(c.tool_call_count).toBeUndefined();
    applyToolCalls(c, 3);
    expect(c.tool_call_count).toBe(3);
  });

  it('accumulates across rounds', () => {
    const c = conv();
    applyToolCalls(c, 2);
    applyToolCalls(c, 4);
    expect(c.tool_call_count).toBe(6);
  });

  // A round with no tool calls is the common case at the end of a turn; it must
  // not materialise the field, or a chat that never called a tool would report
  // "0 tool calls" where "none recorded" is the truth.
  it('leaves the field alone for an empty round', () => {
    const c = conv();
    applyToolCalls(c, 0);
    expect(c.tool_call_count).toBeUndefined();
  });
});
