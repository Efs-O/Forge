import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import { stampToolResultClocks } from '../../src/agent/toolResultClock';
import { chatMessagesFromSlim, slimPersistMessages } from '../../src/sidebar/sessionTypes';

const at = (h: number, m: number): number => new Date(2026, 8, 9, h, m, 0).getTime();

describe('stampToolResultClocks', () => {
  // The whole point: the model reasoned "it's now ~20:50" off a clock it had
  // read 25 minutes earlier, because nothing since had told it the time.
  it('renders each tool result creation time into the model-facing copy', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'a', content: 'first', stampedAt: at(20, 46) },
      { role: 'tool', tool_call_id: 'b', content: 'second', stampedAt: at(21, 10) },
    ];
    const stamped = stampToolResultClocks(messages);
    expect(stamped[1]?.content).toBe('first\n\n[tool result produced at 20:46 local]');
    expect(stamped[2]?.content).toBe('second\n\n[tool result produced at 21:10 local]');
  });

  // Cache safety. A stamp derived from the clock at render time would change
  // the text of an old tool result every round, invalidating the KV cache from
  // that point — 363 seconds of prompt eval on the turn this came from.
  it('is byte-identical across repeated renders', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', tool_call_id: 'a', content: 'x', stampedAt: at(9, 5) },
    ];
    expect(stampToolResultClocks(messages)[0]?.content).toBe(
      stampToolResultClocks(messages)[0]?.content,
    );
  });

  it('leaves the input array untouched', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', tool_call_id: 'a', content: 'raw', stampedAt: at(1, 2) },
    ];
    stampToolResultClocks(messages);
    expect(messages[0]?.content).toBe('raw');
  });

  it('appends a text part to a multimodal result rather than reshaping it', () => {
    const content = [
      { type: 'text' as const, text: 'image loaded' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AA==' } },
    ];
    const stamped = stampToolResultClocks([
      { role: 'tool', tool_call_id: 'a', content, stampedAt: at(7, 30) },
    ]);
    expect(Array.isArray(stamped[0]?.content)).toBe(true);
    expect((stamped[0]?.content as unknown[]).length).toBe(3);
  });

  it('skips non-tool messages and results with no stamp', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'hi' },
      { role: 'tool', tool_call_id: 'a', content: 'legacy row' },
    ];
    expect(stampToolResultClocks(messages)).toEqual(messages);
  });

  /**
   * BL-029. The persisted form wrote `stampedAt` and the restore never read it
   * back, so every tool result from BEFORE a window reload lost its clock line
   * while the ones after it kept theirs — which is exactly the case the header of
   * `toolResultClock.ts` says the per-round stamp exists for: letting the model
   * see how long its own work has been taking. A tool row carries no `createdAt`
   * either, so after a reload there was nothing left to render from.
   */
  it('keeps the stamp through the persisted round trip', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'a', content: 'first', stampedAt: at(20, 46) },
    ];
    const restored = chatMessagesFromSlim(slimPersistMessages(messages));
    expect(restored[1]?.stampedAt).toBe(at(20, 46));
    expect(stampToolResultClocks(restored)[1]?.content).toBe(
      'first\n\n[tool result produced at 20:46 local]',
    );
  });
});
