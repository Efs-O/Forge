import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../src/config/types';
import { ToolCallTruncatedError } from '../../src/llm/ToolCallTruncatedError';
import { truncationGuidance } from '../../src/agent/truncationRecovery';
import { makeAppendFileTool, makeWriteFileTool } from '../../src/tools/builtinTools';
import { MAX_SINGLE_WRITE_CHARS, writeChunkLimit } from '../../src/tools/writeChunking';

// docs/plans/WRITE_CHUNK_LIMIT_PLAN.md

const compact = { enabled: true, at: 0.85 };
const strata = {
  name: 'strata',
  num_ctx: 200000,
  sampling: { max_tokens: 32768 },
} as unknown as ModelConfig;

describe('writeChunkLimit', () => {
  it('keeps the full computed recovery ceiling for a large single-slot window', () => {
    expect(writeChunkLimit(strata, undefined, compact)).toBe(36000);
  });

  it('keeps 6000 for a multi-slot llama.cpp entry', () => {
    const model = { name: 'q', spawn: { num_ctx: 32768, n_parallel: 4 } } as unknown as ModelConfig;
    expect(writeChunkLimit(model, undefined, compact)).toBe(MAX_SINGLE_WRITE_CHARS);
  });

  it('keeps 6000 when the window is unknown or compaction does not bound it', () => {
    const cloud = { name: 'cloud' } as unknown as ModelConfig;
    expect(writeChunkLimit(cloud, undefined, compact)).toBe(MAX_SINGLE_WRITE_CHARS);
    expect(writeChunkLimit(strata, undefined, undefined)).toBe(MAX_SINGLE_WRITE_CHARS);
    expect(writeChunkLimit(strata, undefined, { enabled: false })).toBe(MAX_SINGLE_WRITE_CHARS);
  });

  it('is capped by the model output limit and spends its reasoning budget', () => {
    const capped = { ...strata, sampling: { max_tokens: 16000 } } as ModelConfig;
    // 16000 - 8000 thinking - 4000 headroom = 4000 tokens -> 8000 chars.
    expect(writeChunkLimit(capped, undefined, compact)).toBe(8000);
    const budgeted = {
      ...capped,
      extra_llama_server_args: ['--reasoning-budget', '10000'],
    } as ModelConfig;
    expect(writeChunkLimit(budgeted, undefined, compact)).toBe(MAX_SINGLE_WRITE_CHARS);
  });
});

describe('write tool descriptions', () => {
  const definitions = [makeWriteFileTool().definition, makeAppendFileTool().definition];

  it('contains no proactive size or chunking advice', () => {
    for (const definition of definitions) {
      const json = JSON.stringify(definition);
      expect(json).not.toMatch(/characters? should be split|chunk|size limit/i);
    }
  });
});

describe('truncation guidance', () => {
  const err = new ToolCallTruncatedError({ finishReason: 'length', message: 'cut' });

  it('never states a ceiling above the model limit', () => {
    expect(truncationGuidance(err, 100000, 36000)).toContain('at most 36000 characters');
    expect(truncationGuidance(err, 100000)).toContain(
      `at most ${MAX_SINGLE_WRITE_CHARS} characters`,
    );
    expect(truncationGuidance(err, 3000, 24000)).toContain('at most 5000 characters');
  });
});
