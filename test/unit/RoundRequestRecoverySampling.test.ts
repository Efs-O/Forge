import { describe, expect, it } from 'vitest';
import { buildRoundRequest } from '../../src/agent/buildRoundRequest';
import type { ModelConfig } from '../../src/config/types';
import type { ChatMessage, ToolDefinition } from '../../src/llm/types';

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: { name: 'read_file', parameters: { type: 'object', properties: {} } },
  },
];

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'go' }];

function build(model: ModelConfig, suppressThinking = false) {
  return buildRoundRequest({
    model,
    prepared: MESSAGES,
    toolDefinitions: TOOLS,
    nativeTools: true,
    stripAllTools: undefined,
    includeUsage: true,
    maxOutputTokens: 4096,
    canUseThinkingKwargs: true,
    suppressThinking,
    outputRoom: undefined,
  });
}

const SAMPLED: ModelConfig = {
  name: 'sampled',
  sampling: { temperature: 0.31, top_p: 0.77, seed: 1234, stop: ['<|end|>'] },
};

describe('buildRoundRequest recovery request', () => {
  // The retry is the same round with the tools taken away. Built from the
  // un-merged base it ran at the server's own temperature with no seed and no
  // stop list, so the recovery round was not comparable to the round that just
  // failed — and a model that only misbehaves at its configured temperature
  // misbehaved again forever.
  it('carries the same sampling as the request it recovers from', () => {
    const built = build(SAMPLED);
    expect(built.usesNativeTools).toBe(true);
    expect(built.request.tools).toHaveLength(1);
    expect(built.fallbackRequest.tools).toBeUndefined();
    expect(built.fallbackRequest.temperature).toBe(built.request.temperature);
    expect(built.fallbackRequest.top_p).toBe(built.request.top_p);
    expect(built.fallbackRequest.seed).toBe(built.request.seed);
    expect(built.fallbackRequest.stop).toEqual(built.request.stop);
    expect(built.fallbackRequest.max_tokens).toBe(built.request.max_tokens);
  });

  it('teaches the fenced format only on the tool-less request', () => {
    const built = build(SAMPLED);
    const primary = String(built.request.messages[0]?.content ?? '');
    const fallback = String(built.fallbackRequest.messages[0]?.content ?? '');
    expect(primary).not.toContain('Native tool calling is unavailable');
    expect(fallback).toContain('Native tool calling is unavailable');
  });

  it('keeps a deliberate thinking-off override on both requests', () => {
    const built = build({ name: 'llama-ish', think: true }, true);
    expect(built.request.chat_template_kwargs).toMatchObject({ enable_thinking: false });
    expect(built.fallbackRequest.chat_template_kwargs).toEqual(built.request.chat_template_kwargs);
  });
});
