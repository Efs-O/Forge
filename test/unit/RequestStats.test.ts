import { describe, expect, it } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import {
  createRequestClientClock,
  requestStatsRow,
} from '../../src/sessions/requestStats';

const client = { total_ms: 12.4, chunks: 3, ttfb_ms: 1.2, first_token_ms: 4.1 };

describe('request_stats rows', () => {
  it('keeps only finite whitelisted server timings and omits missing values', () => {
    const row = requestStatsRow(
      {
        outcome: 'ok',
        timings: {
          prompt_n: 120,
          prompt_ms: 40.5,
          cache_n: 80,
          predicted_n: 3,
          predicted_ms: Number.NaN,
          draft_n: Number.POSITIVE_INFINITY,
          draft_n_accepted: 2,
          unexpected_payload: 'must not leak',
        },
        client,
      },
      'model-a',
      1,
    );

    expect(row.server).toEqual({
      prompt_n: 120,
      prompt_ms: 40.5,
      cache_n: 80,
      predicted_n: 3,
      draft_n_accepted: 2,
    });
    expect(JSON.stringify(row)).not.toContain('unexpected_payload');
    expect(row).not.toHaveProperty('prompt_tokens');
    expect(row).not.toHaveProperty('completion_tokens');
  });

  it('converts Ollama nanoseconds to milliseconds rounded to a tenth', () => {
    const row = requestStatsRow(
      {
        outcome: 'ok',
        ollamaDurations: {
          load_duration: 1_234_567,
          prompt_eval_duration: 22_260_000,
          eval_duration: 99_949_999,
          total_duration: 123_456_789,
        },
        client,
      },
      'ollama-model',
      2,
    );

    expect(row.ollama).toEqual({
      load_ms: 1.2,
      prompt_eval_ms: 22.3,
      eval_ms: 99.9,
      total_ms: 123.5,
    });
  });

  it('keeps request text and tool arguments out of the serialized row', () => {
    const sentinel = 'PRIVATE_REQUEST_SENTINEL_9d21';
    const request = {
      messages: [{ role: 'user', content: sentinel }],
      tools: [{ function: { name: 'write_file', arguments: sentinel } }],
    };
    const row = requestStatsRow(
      {
        outcome: 'error',
        usage: {
          prompt_tokens: 8,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 3 },
        },
        client,
      },
      'model-private',
      3,
    );

    expect(JSON.stringify(request)).toContain(sentinel);
    expect(JSON.stringify(row)).not.toContain(sentinel);
    expect(row).toMatchObject({ prompt_tokens: 8, completion_tokens: 2, cached_tokens: 3 });
  });

  it('keeps first-token time within total and omits events that never happened', () => {
    let now = 100;
    const clock = createRequestClientClock(() => now);
    now = 101;
    clock.firstByte();
    now = 104;
    clock.firstToken();
    now = 112;
    clock.chunk();
    const withToken = clock.finish();
    expect(withToken.first_token_ms).toBeLessThanOrEqual(withToken.total_ms);

    let emptyNow = 10;
    const emptyClock = createRequestClientClock(() => emptyNow);
    emptyNow = 15;
    const noToken = emptyClock.finish();
    expect(noToken).toEqual({ total_ms: 5, chunks: 0 });
  });
});

describe('record_requests config', () => {
  const base = () => ({
    active_model: 'm',
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
  });

  it('requires the block fields and enforces the documented integer bounds', () => {
    const valid = ForgeConfigSchema.safeParse({
      ...base(),
      record_requests: { enabled: false, max_mb: 1, keep_hours: 720 },
    });
    expect(valid.success).toBe(true);
    expect(
      ForgeConfigSchema.safeParse({
        ...base(),
        record_requests: { enabled: true, max_mb: 10_000, keep_hours: 1 },
      }).success,
    ).toBe(true);

    const missingSize = ForgeConfigSchema.safeParse({
      ...base(),
      record_requests: { enabled: true, keep_hours: 24 },
    });
    expect(missingSize.success).toBe(false);
    const missingExpiry = ForgeConfigSchema.safeParse({
      ...base(),
      record_requests: { enabled: true, max_mb: 500 },
    });
    expect(missingExpiry.success).toBe(false);

    for (const block of [
      { enabled: true, max_mb: 0, keep_hours: 24 },
      { enabled: true, max_mb: 10_001, keep_hours: 24 },
      { enabled: true, max_mb: 500, keep_hours: 0 },
      { enabled: true, max_mb: 500, keep_hours: 721 },
      { enabled: true, max_mb: 1.5, keep_hours: 24 },
    ]) {
      expect(ForgeConfigSchema.safeParse({ ...base(), record_requests: block }).success).toBe(false);
    }

    expect(ForgeConfigSchema.safeParse(base()).success).toBe(true);
  });
});
