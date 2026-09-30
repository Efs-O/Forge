import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import { neutralizeMediaMarkers } from '../../src/llm/mediaMarkerGuard';
import { normalizeRequestForModel } from '../../src/llm/RequestNormalizer';
import type { ChatMessage } from '../../src/llm/types';

// The marker llama-server b11243 published in GET /props on 2026-09-30; a
// Phase-0 turn that curled /props died on the next request with it in history.
const RANDOM = '<__media_Wzm8X40uj5dnDZkjB7xftebaQrK7IJj9__>';
const LEGACY = '<__media__>';

describe('neutralizeMediaMarkers', () => {
  it('breaks random and legacy markers in string, part, reasoning and tool-arg text', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: `{"media_marker":"${RANDOM}"}`, tool_call_id: 't1' },
      { role: 'user', content: [{ type: 'text', text: `see ${LEGACY}` }] },
      {
        role: 'assistant',
        content: null,
        reasoning_content: `the marker is ${RANDOM}`,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'exec_command', arguments: JSON.stringify({ args: [RANDOM] }) },
          },
        ],
      },
    ];
    const out = neutralizeMediaMarkers(messages);
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(RANDOM);
    expect(wire).not.toContain(LEGACY);
    expect(out[0]?.content).toBe(
      `{"media_marker":"<__media​_Wzm8X40uj5dnDZkjB7xftebaQrK7IJj9__>"}`,
    );
    // The original transcript is not mutated.
    expect(messages[0]?.content).toContain(RANDOM);
  });

  it('returns the same array when nothing carries a marker (cache-neutral)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'plain <__media text and __media__ without brackets' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:,' } }] },
    ];
    expect(neutralizeMediaMarkers(messages)).toBe(messages);
  });

  it('is applied to llama.cpp requests and not to other providers', () => {
    const request = { messages: [{ role: 'user' as const, content: RANDOM }] };
    const llama: ModelConfig = { name: 'local', provider: 'llama.cpp' } as ModelConfig;
    const cloud: ModelConfig = { name: 'grok', provider: 'xai' } as ModelConfig;
    expect(JSON.stringify(normalizeRequestForModel(request, llama))).not.toContain(RANDOM);
    expect(normalizeRequestForModel(request, cloud)).toBe(request);
  });
});
