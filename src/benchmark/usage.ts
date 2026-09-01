/**
 * Usage evidence readers shared by the coding benchmark.
 *
 * These deliberately follow the transcript shapes validated by CacheWarden;
 * no provider API key or CacheWarden runtime dependency is involved.
 */
export interface UsageEvidence {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens?: number;
  source: 'claude-transcript' | 'codex-rollout';
}

export function readClaudeUsage(lines: readonly string[]): UsageEvidence | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const usage = JSON.parse(lines[index]).message?.usage;
      if (!usage) continue;
      const cachedInputTokens = number(usage.cache_read_input_tokens);
      const cacheCreationInputTokens = number(usage.cache_creation_input_tokens);
      return {
        inputTokens: number(usage.input_tokens) + cachedInputTokens + cacheCreationInputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        source: 'claude-transcript',
      };
    } catch {
      // A concurrently-written JSONL tail may end in a partial record.
    }
  }
  return undefined;
}

export function readCodexUsage(lines: readonly string[]): UsageEvidence | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const usage = JSON.parse(lines[index]).payload?.info?.last_token_usage;
      if (!usage) continue;
      return {
        inputTokens: number(usage.input_tokens),
        cachedInputTokens: number(usage.cached_input_tokens),
        source: 'codex-rollout',
      };
    } catch {
      // Ignore malformed and partial JSONL records.
    }
  }
  return undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
