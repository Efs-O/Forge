import { describe, expect, it } from 'vitest';
import {
  formatPromptCacheStats,
  readPromptCacheStats,
} from '../../src/llm/promptCacheStats';

describe('readPromptCacheStats', () => {
  it('reads the shape llama-server actually returns', () => {
    // Verbatim from b10430 on an append-only turn.
    const stats = readPromptCacheStats({
      prompt_tokens: 4966,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 4945 },
    });
    expect(stats).toEqual({
      promptTokens: 4966,
      cachedTokens: 4945,
      evaluatedTokens: 21,
      hitRate: 4945 / 4966,
    });
  });

  it('distinguishes "not reported" from "nothing was cached"', () => {
    // A cloud provider or an older llama.cpp omits the field. Rendering that
    // as a 0% hit rate would report a Forge bug that is not there.
    expect(readPromptCacheStats({ prompt_tokens: 100 })).toBeUndefined();
    expect(readPromptCacheStats({ prompt_tokens: 100, prompt_tokens_details: {} })).toBeUndefined();
    expect(readPromptCacheStats(undefined)).toBeUndefined();
    expect(readPromptCacheStats({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } }))
      .toEqual({ promptTokens: 100, cachedTokens: 0, evaluatedTokens: 100, hitRate: 0 });
  });

  it('clamps a provider reporting more cached than prompt', () => {
    const stats = readPromptCacheStats({
      prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: 99 },
    });
    expect(stats?.evaluatedTokens).toBe(0);
    expect(stats?.hitRate).toBe(1);
  });

  it('does not divide by zero on an empty prompt', () => {
    const stats = readPromptCacheStats({
      prompt_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(stats?.hitRate).toBe(0);
  });
});

describe('formatPromptCacheStats', () => {
  it('is one line and carries no prompt contents', () => {
    const line = formatPromptCacheStats({
      promptTokens: 24610,
      cachedTokens: 24102,
      evaluatedTokens: 508,
      hitRate: 24102 / 24610,
    });
    expect(line).toBe('[cache] prompt=24610 cached=24102 (97.9%) evaluated=508');
    expect(line).not.toContain('\n');
  });
});
