import { describe, expect, it } from 'vitest';
import {
  createTurnSpeedLedger,
  formatSpeedLine,
  type TurnSpeedTotals,
} from '../../src/sessions/turnSpeedTotals';
import type { RequestCapture } from '../../src/sessions/requestStats';

/**
 * The two shapes the line is built from, taken from what these engines really
 * report. The first pair is this chat's own Strata request log on 2026-10-27
 * (`~/.forge/sessions/*.jsonl`, `request_stats` rows): `prompt_n` is what the
 * engine actually processed, and the reused part arrives as `cache_n` — so
 * 878 + 18,511 = 19,389 equals the `prompt_tokens` the usage block reported,
 * which is why `prompt_n` is the "newly read" number the line wants.
 */
const STRATA_FIRST = {
  cache_n: 0,
  prompt_n: 18_282,
  prompt_ms: 21_294.5,
  prompt_per_second: 858.5,
  predicted_n: 230,
  predicted_ms: 6_897.5,
  predicted_per_second: 33.3,
  draft_n: 0,
  draft_n_accepted: 0,
};
const STRATA_SECOND = {
  cache_n: 18_511,
  prompt_n: 878,
  prompt_ms: 5_117.6,
  prompt_per_second: 171.6,
  predicted_n: 305,
  predicted_ms: 18_493.1,
  predicted_per_second: 16.5,
  draft_n: 27,
  draft_n_accepted: 24,
};

function capture(stats: {
  usage?: unknown;
  timings?: unknown;
  ollamaDurations?: Record<string, unknown>;
}): RequestCapture {
  return {
    body: '{"messages":[…]}',
    url: 'http://127.0.0.1:8092/v1/chat/completions',
    model: 'qwen3.8-flash-next-abliterated-iq2_xs',
    sentAtMs: 1_793_139_252_000,
    stats: {
      outcome: 'ok',
      finishReason: 'stop',
      client: { total_ms: 30_000, chunks: 192 },
      ...stats,
    },
  };
}

const totals = (
  generatedTokens: number,
  generatedMs: number,
  readTokens: number,
  readMs: number,
): TurnSpeedTotals => ({ generatedTokens, generatedMs, readTokens, readMs });

describe("one turn's server timings summed into its speed line", () => {
  it('sums the requests that reported timings and ignores the one that did not', () => {
    const ledger = createTurnSpeedLedger();
    ledger.beginTurn('c1');
    ledger.record('c1', capture({ usage: { prompt_tokens: 18_282, completion_tokens: 230 }, timings: STRATA_FIRST }));
    // A request with no timings at all: a retry against a provider that
    // reported nothing. It must not dilute the line, and it must not be
    // counted as zero tokens or zero time.
    ledger.record('c1', capture({ usage: { prompt_tokens: 27_620, completion_tokens: 156 } }));
    ledger.record('c1', capture({ usage: { prompt_tokens: 19_389, completion_tokens: 305 }, timings: STRATA_SECOND }));

    // 535 generated over 25,390.6 ms, and 19,160 newly read over 26,412.1 ms.
    expect(ledger.finishTurn('c1')).toBe(
      'Speed: 535 tokens at 21.1 tok/s · read 19,160 at 725.4 tok/s',
    );
  });

  it('reads native Ollama counts and nanosecond durations', () => {
    const ledger = createTurnSpeedLedger();
    ledger.beginTurn('c1');
    ledger.record(
      'c1',
      capture({
        // `reportOllamaUsage` maps eval_count / prompt_eval_count onto the
        // usage block, and the durations arrive separately in nanoseconds.
        usage: { prompt_tokens: 1_200, completion_tokens: 150, total_tokens: 1_350 },
        ollamaDurations: {
          load_duration: 0,
          prompt_eval_duration: 2_000_000_000,
          eval_duration: 3_500_000_000,
          total_duration: 5_500_000_000,
        },
      }),
    );
    expect(ledger.finishTurn('c1')).toBe(
      'Speed: 150 tokens at 42.9 tok/s · read 1,200 at 600.0 tok/s',
    );
  });

  it('gives no line to a turn whose requests reported no server timings', () => {
    const ledger = createTurnSpeedLedger();
    ledger.beginTurn('c1');
    // A cloud reply: exact usage counts, no server timings, no measured time.
    // Showing a wall-clock rate here would be a guess dressed as a measurement.
    ledger.record('c1', capture({ usage: { prompt_tokens: 9_000, completion_tokens: 400 } }));
    ledger.record('c1', capture({}));
    expect(ledger.finishTurn('c1')).toBeUndefined();
    expect(ledger.takeLine('c1')).toBeUndefined();
  });

  it('says only what was measured', () => {
    expect(formatSpeedLine(totals(1_830, 44_000, 0, 0))).toBe('Speed: 1,830 tokens at 41.6 tok/s');
    expect(formatSpeedLine(totals(0, 0, 12_400, 15_122))).toBe('Speed: read 12,400 at 820.0 tok/s');
    // A reported count with no time behind it is not a rate.
    expect(formatSpeedLine(totals(500, 0, 900, 1_000))).toBe('Speed: read 900 at 900.0 tok/s');
    expect(formatSpeedLine(totals(0, 0, 0, 0))).toBeUndefined();
  });

  it("keeps one turn's sums apart from another conversation's", () => {
    const ledger = createTurnSpeedLedger();
    ledger.beginTurn('c1');
    ledger.beginTurn('c2');
    ledger.record('c1', capture({ timings: STRATA_FIRST }));
    expect(ledger.finishTurn('c2')).toBeUndefined();
    expect(ledger.finishTurn('c1')).toContain('Speed: 230 tokens at 33.3 tok/s');
  });

  it('hands the line out once, so a turn cannot put its speed on two messages', () => {
    const ledger = createTurnSpeedLedger();
    ledger.beginTurn('c1');
    ledger.record('c1', capture({ timings: STRATA_FIRST }));
    const line = ledger.finishTurn('c1');
    expect(line).toBeTruthy();
    expect(ledger.takeLine('c1')).toBe(line);
    expect(ledger.takeLine('c1')).toBeUndefined();
  });

  it('drops the sums of a turn that ended without an answer', () => {
    const ledger = createTurnSpeedLedger();
    ledger.beginTurn('c1');
    ledger.record('c1', capture({ timings: STRATA_FIRST }));
    ledger.abandonTurn('c1');
    expect(ledger.takeLine('c1')).toBeUndefined();
  });

  it("does not let a turn that never ended wear the next turn's line", () => {
    const ledger = createTurnSpeedLedger();
    ledger.beginTurn('c1');
    ledger.record('c1', capture({ timings: STRATA_FIRST }));
    // The window closed mid-request: no finish, no abandon, nothing was taken.
    ledger.beginTurn('c1');
    ledger.record('c1', capture({ timings: STRATA_SECOND }));
    expect(ledger.finishTurn('c1')).toBe('Speed: 305 tokens at 16.5 tok/s · read 878 at 171.6 tok/s');
  });
});
