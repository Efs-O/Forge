import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlStatsBuilder, controlStatsSchema } from '../../src/backend/controlStats';

const FIXED_NOW = new Date(2026, 9, 5, 12).getTime();
const today = new Date(FIXED_NOW);
const yesterday = new Date(2026, 9, 4, 12).getTime();

describe('control stats', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(now = FIXED_NOW): {
    dir: string;
    setNow: (value: number) => void;
    now: () => number;
    write: (name: string, rows: unknown[], mtime?: number, torn?: string) => string;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-control-stats-'));
    dirs.push(dir);
    let clock = now;
    return {
      dir,
      setNow: (value) => {
        clock = value;
      },
      now: () => clock,
      write: (name, rows, mtime = FIXED_NOW, torn = '') => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n' + torn);
        fs.utimesSync(file, mtime / 1_000, mtime / 1_000);
        return file;
      },
    };
  }

  function builder(dir: string, now: () => number = () => FIXED_NOW) {
    return createControlStatsBuilder({
      sessionsDir: dir,
      now,
      forgeVersion: 'test-version',
      contextLimitFor: (model) => (model === 'model-a' ? 8192 : null),
    });
  }

  it('counts each row kind and selects the newest usage request', () => {
    const env = setup();
    env.write('session.jsonl', [
      { type: 'session_start', timestamp_ms: FIXED_NOW },
      { role: 'user', timestamp_ms: FIXED_NOW },
      { role: 'user', timestamp_ms: FIXED_NOW + 1 },
      {
        type: 'usage',
        timestamp_ms: FIXED_NOW + 2,
        model: 'model-a',
        input_tokens: 12,
        output_tokens: 3,
        model_request_count: 1,
      },
      {
        type: 'usage',
        timestamp_ms: FIXED_NOW + 3,
        model: 'unknown',
        input_tokens: 32,
        output_tokens: 10,
        model_request_count: 2,
      },
      { type: 'compaction', timestamp_ms: FIXED_NOW },
      { type: 'compaction_attempt', phase: 'finished', outcome: 'failed', timestamp_ms: FIXED_NOW },
      {
        type: 'compaction_attempt',
        phase: 'finished',
        outcome: 'compacted',
        timestamp_ms: FIXED_NOW,
      },
      { type: 'compaction_attempt', phase: 'suppressed', timestamp_ms: FIXED_NOW },
      { role: 'tool', content: 'ok', timestamp_ms: FIXED_NOW },
      { role: 'tool', content: 'Error: distinctive failure', timestamp_ms: FIXED_NOW },
      { role: 'tool', content: 'User declined: no', timestamp_ms: FIXED_NOW },
      { type: 'turn_error', message: 'private error', timestamp_ms: FIXED_NOW },
    ]);
    const result = builder(env.dir).build();
    expect(result.today).toEqual({
      turns: 2,
      requests: 2,
      compactions: 1,
      compaction_attempts_failed: 1,
      compactions_suppressed: 1,
      tool_calls: 3,
      tool_failures: 2,
      input_tokens: 32,
      output_tokens: 10,
      turn_errors: 1,
    });
    expect(result.last_request).toEqual({
      model: 'unknown',
      input_tokens: 20,
      context_limit: null,
      at: Math.floor((FIXED_NOW + 3) / 1_000),
    });
    expect(controlStatsSchema.parse(result)).toEqual(result);
  });

  it('counts usage as deltas of session-to-date totals', () => {
    const env = setup();
    const yesterday = FIXED_NOW - 24 * 60 * 60 * 1_000;
    const usage = (at: number, requests: number, input: number, output: number) => ({
      type: 'usage',
      timestamp_ms: at,
      model: 'model-a',
      model_request_count: requests,
      input_tokens: input,
      output_tokens: output,
    });
    env.write('session.jsonl', [
      { type: 'session_start', timestamp_ms: yesterday },
      usage(yesterday, 10, 1_000_000, 5_000),
      usage(FIXED_NOW, 11, 1_100_000, 5_200),
      // One flush covering three requests: counted, but not a prompt size.
      usage(FIXED_NOW + 1, 14, 1_400_000, 6_000),
    ]);
    env.write('restarted.jsonl', [
      { type: 'session_start', timestamp_ms: FIXED_NOW },
      usage(FIXED_NOW, 50, 900_000, 900),
      // A total that went backwards restarted from zero.
      usage(FIXED_NOW + 2, 1, 7_000, 70),
    ]);
    const result = builder(env.dir).build();
    expect(result.today).toMatchObject({
      requests: 4 + 50 + 1,
      input_tokens: 400_000 + 900_000 + 7_000,
      output_tokens: 1_000 + 900 + 70,
    });
    expect(result.last_request).toEqual({
      model: 'model-a',
      input_tokens: 7_000,
      context_limit: 8192,
      at: Math.floor((FIXED_NOW + 2) / 1_000),
    });
  });

  it('counts replayed session rows once', () => {
    const env = setup();
    const u1 = { role: 'user', content: 'same', timestamp_ms: FIXED_NOW };
    const a1 = { role: 'assistant', content: 'answer', timestamp_ms: FIXED_NOW };
    const u2 = { role: 'user', content: 'second', timestamp_ms: FIXED_NOW + 1 };
    const a2 = { role: 'assistant', content: 'answer two', timestamp_ms: FIXED_NOW + 1 };
    env.write('replayed.jsonl', [
      { type: 'session_start', timestamp_ms: FIXED_NOW },
      u1,
      a1,
      u2,
      a2,
      u1,
      a1,
      u2,
      a2,
    ]);
    expect(builder(env.dir).build().today.turns).toBe(2);
  });

  it('skips a torn final row', () => {
    const env = setup();
    env.write(
      'torn.jsonl',
      [
        { type: 'session_start', timestamp_ms: FIXED_NOW },
        { role: 'user', timestamp_ms: FIXED_NOW },
      ],
      FIXED_NOW,
      '{"type":"usage"',
    );
    expect(builder(env.dir).build().today).toMatchObject({ turns: 1, requests: 0 });
  });

  it("ignores yesterday's rows even in a file modified today", () => {
    const env = setup();
    env.write('mixed.jsonl', [
      { type: 'session_start', timestamp_ms: FIXED_NOW },
      { role: 'user', timestamp_ms: yesterday },
      { role: 'user', timestamp_ms: FIXED_NOW },
    ]);
    expect(builder(env.dir).build().today.turns).toBe(1);
  });

  it('returns zero counts for a missing sessions directory', () => {
    const result = builder(path.join(os.tmpdir(), `missing-${Date.now()}`)).build();
    expect(result.today).toEqual({
      turns: 0,
      requests: 0,
      compactions: 0,
      compaction_attempts_failed: 0,
      compactions_suppressed: 0,
      tool_calls: 0,
      tool_failures: 0,
      input_tokens: 0,
      output_tokens: 0,
      turn_errors: 0,
    });
    expect(result.skipped_files).toBe(0);
  });

  it('drops old-day file cache entries when the injected local day rolls over', () => {
    const env = setup();
    const file = env.write('session.jsonl', [
      { type: 'session_start', timestamp_ms: FIXED_NOW },
      { role: 'user', timestamp_ms: FIXED_NOW },
    ]);
    const stats = builder(env.dir, env.now);
    expect(stats.build().today.turns).toBe(1);
    const unchanged = fs.statSync(file);
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session_start', timestamp_ms: FIXED_NOW }),
        JSON.stringify({ role: 'user', timestamp_ms: FIXED_NOW }),
        JSON.stringify({ role: 'user', timestamp_ms: FIXED_NOW + 1 }),
        '',
      ].join('\n'),
    );
    fs.utimesSync(file, unchanged.atime, unchanged.mtime);
    env.write(
      'next-day.jsonl',
      [
        { type: 'session_start', timestamp_ms: FIXED_NOW + 86_400_000 },
        { role: 'user', timestamp_ms: FIXED_NOW + 86_400_000 },
      ],
      FIXED_NOW + 86_400_000,
    );
    env.setNow(FIXED_NOW + 86_400_000);
    expect(stats.build().today.turns).toBe(1);
    env.setNow(today.getTime());
    expect(stats.build().today.turns).toBe(2);
  });

  it('never copies prompt, summary, reasoning, message, or tool arguments into the reply', () => {
    const env = setup();
    env.write('private.jsonl', [
      { type: 'session_start', timestamp_ms: FIXED_NOW, title: 'LEAK_TITLE_91' },
      { role: 'user', content: 'LEAK_CONTENT_92', timestamp_ms: FIXED_NOW },
      {
        role: 'assistant',
        summary: 'LEAK_SUMMARY_93',
        reasoning: 'LEAK_REASONING_94',
        timestamp_ms: FIXED_NOW,
      },
      {
        role: 'assistant',
        tool_calls: [{ name: 'x', input: { secret: 'LEAK_ARGUMENT_95' } }],
        timestamp_ms: FIXED_NOW,
      },
      { type: 'turn_error', message: 'LEAK_MESSAGE_96', timestamp_ms: FIXED_NOW },
      { type: 'compaction', summary: 'LEAK_COMPACTION_97', timestamp_ms: FIXED_NOW },
    ]);
    const serialized = JSON.stringify(builder(env.dir).build());
    for (const secret of [
      'LEAK_TITLE_91',
      'LEAK_CONTENT_92',
      'LEAK_SUMMARY_93',
      'LEAK_REASONING_94',
      'LEAK_ARGUMENT_95',
      'LEAK_MESSAGE_96',
      'LEAK_COMPACTION_97',
    ])
      expect(serialized).not.toContain(secret);
  });

  it('excludes unrelated JSONL files that lack a session_start row', () => {
    const env = setup();
    env.write('voice.jsonl', [{ role: 'user', timestamp_ms: FIXED_NOW }]);
    expect(builder(env.dir).build().today.turns).toBe(0);
  });
});
