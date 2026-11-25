import { describe, expect, it } from 'vitest';
import {
  BROKEN_TOOL_CALL_NUDGE,
  nudgeBrokenToolCall,
} from '../../src/agent/brokenToolCallMarkup';
import { MID_TURN_WIRE_LABEL, wireMessageContent } from '../../src/llm/wireRequest';
import type { ChatMessage } from '../../src/llm/types';
import { injectTurnContext } from '../../src/sidebar/turnContext';

/** Layer C's delimiter, `turnContext.ts`'s `OPEN`. */
const BLOCK_OPEN = '[Forge turn context, as of this message]';

/** What the model printed instead of a call: markup, nothing parsed. */
const BROKEN_ANSWER = '<tool_call>\n{"name": }\n</tool_call>';

const STATE = { currentDate: '2026-11-25' };

function nudgesOf(list: readonly ChatMessage[]): string[] {
  return list.filter((m) => m.internal === true).map((m) => String(m.content));
}

function blockCount(list: readonly ChatMessage[]): number {
  const joined = list.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  return joined.split(BLOCK_OPEN).length - 1;
}

/**
 * Session 22f64367 (2026-11-25): the nudge was the only non-`midTurn` user
 * message left in the window, so the Layer C finders picked it as the message
 * that opened the turn. The live block folded into it, and the next turn moved
 * the block off again — `first_changed: 137, changed_role: user` — which dropped
 * the prompt cache for everything behind it. The nudge is not the turn opener;
 * it is a message in the middle of the turn.
 */
describe('the broken-markup nudge and the turn context', () => {
  it('leaves the nudge untouched and folds the block onto the message that opened the turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'read me the tips file' },
      { role: 'assistant', content: BROKEN_ANSWER },
    ];
    expect(nudgeBrokenToolCall(messages, BROKEN_ANSWER)).toBe(true);

    const out = injectTurnContext(messages, STATE);

    expect(nudgesOf(out)).toEqual([BROKEN_TOOL_CALL_NUDGE]);
    expect(blockCount(out)).toBe(1);
    expect(String(out[0]?.content).startsWith(BLOCK_OPEN)).toBe(true);
  });

  it('keeps the nudge byte-identical when the next real user message arrives', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: BROKEN_ANSWER },
    ];
    nudgeBrokenToolCall(messages, BROKEN_ANSWER);
    const first = injectTurnContext(messages, STATE);

    messages.push({ role: 'assistant', content: 'Now the call works.' });
    messages.push({ role: 'user', content: 'and the changelog too' });
    const second = injectTurnContext(messages, STATE);

    // The wire bytes of a message in the middle of the conversation must not
    // move between turns: that is the whole cache behind it.
    expect(nudgesOf(first)).toEqual([BROKEN_TOOL_CALL_NUDGE]);
    expect(nudgesOf(second)).toEqual([BROKEN_TOOL_CALL_NUDGE]);
    expect(blockCount(second)).toBe(1);
  });

  it('still freezes the block onto an internal message that opens a turn', () => {
    // The finder skips `midTurn`, not `internal`: a background-job notice that
    // starts a turn is the turn opener, and it keeps the freeze.
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'waiting for the job' },
      { role: 'user', content: 'Background job "watch" finished.', internal: true },
    ];
    const out = injectTurnContext(messages, STATE);
    expect(String(out[1]?.content).startsWith(BLOCK_OPEN)).toBe(true);
  });
});

describe('wireMessageContent', () => {
  it('does not put the user-tell label on Forge’s own internal messages', () => {
    expect(wireMessageContent({ content: 'x', midTurn: true, internal: true })).toBe('x');
  });

  it('still labels a real mid-turn user tell', () => {
    expect(wireMessageContent({ content: 'x', midTurn: true })).toBe(
      `${MID_TURN_WIRE_LABEL}\n\nx`,
    );
  });

  it('leaves a message that is not mid-turn alone', () => {
    expect(wireMessageContent({ content: 'x' })).toBe('x');
  });
});
