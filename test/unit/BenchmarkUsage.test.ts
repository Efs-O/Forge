import { describe, expect, it } from 'vitest';
import { readClaudeUsage, readCodexUsage } from '../../src/benchmark/usage';

describe('benchmark usage evidence', () => {
  it('reads the latest Claude transcript usage in CacheWarden format', () => {
    const usage = readClaudeUsage([
      'not json',
      JSON.stringify({ message: { usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } }),
    ]);
    expect(usage).toEqual({ inputTokens: 60, cachedInputTokens: 30, cacheCreationInputTokens: 20, source: 'claude-transcript' });
  });

  it('reads the latest Codex rollout token_count record', () => {
    const usage = readCodexUsage([
      JSON.stringify({ payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0 } } } }),
      JSON.stringify({ payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 80 } } } }),
    ]);
    expect(usage).toEqual({ inputTokens: 100, cachedInputTokens: 80, source: 'codex-rollout' });
  });

  it('does not invent usage when no recognised evidence exists', () => {
    expect(readClaudeUsage(['{}'])).toBeUndefined();
    expect(readCodexUsage(['{}'])).toBeUndefined();
  });
});
