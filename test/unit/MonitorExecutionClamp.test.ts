import { afterEach, describe, expect, it, vi } from 'vitest';
import { backgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import type { BackgroundExecutionObservation } from '../../src/tools/BackgroundExecutionManager';
import {
  makeMonitorExecutionTool,
} from '../../src/tools/backgroundExecutionTools';

describe('monitor_execution wait limit', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clamps wait_ms above 60000 and reports the clamp', async () => {
    const observe = vi.spyOn(backgroundExecutionManager, 'observe').mockResolvedValue({
      id: 'exec-clamp',
      command: 'node',
      status: 'running',
      pid: 1,
      startedAt: Date.now(),
      finishedAt: undefined,
      exitCode: null,
      error: undefined,
      stdout: '',
      stderr: '',
      stdoutStart: 0,
      stderrStart: 0,
      stdoutEnd: 0,
      stderrEnd: 0,
      stdoutOldest: 0,
      stderrOldest: 0,
      stdoutDropped: 0,
      stderrDropped: 0,
    });
    const result = await makeMonitorExecutionTool().handler({
      execution_id: 'exec-clamp',
      wait_ms: 60_001,
    });
    expect(observe).toHaveBeenCalledWith('exec-clamp', 60_000, 0, 0, undefined);
    expect(result).toContain('wait_ms clamped to 60000');
  });
});

/**
 * Measured 2026-11-20: this week's session scan counted 6 refusals reading
 * `monitor_execution: unknown argument "suggested_next_wait_ms"`. Our own text
 * caused them — "Reuse the returned cursors and suggested_next_wait_ms" reads as
 * an instruction to send that result field back as an argument, and the round is
 * spent on a refusal. The advertised text now names the arguments instead, and
 * these strings are pinned whole (docs/plans/SESSION_SCAN_CAUSE_FIXES_PLAN.md
 * Phase 2): a rewording that drops the argument names fails here.
 */
describe('monitor_execution advertised text', () => {
  const monitor = makeMonitorExecutionTool().definition.function;
  const properties = (monitor.parameters as { properties: Record<string, { description?: string }> })
    .properties;

  it('names the arguments to send back, not the result fields it returns', () => {
    expect(monitor.description).toBe(
      'Wait for a background shell command and return new output plus status when this turn must see the output: a background job wakes the chat on its own when it ends, so watching one does not have to hold a turn open. Send the returned next_stdout_cursor and next_stderr_cursor back as stdout_cursor and stderr_cursor, and the returned suggested_next_wait_ms value as wait_ms; *_dropped_chars means that output is gone. A running job with no output may be silent: inspect its artifact, including nearby or nested .part/.tmp files, instead of polling rapidly.',
    );
  });

  it('says where the suggested wait goes', () => {
    expect(properties['wait_ms']?.description).toBe(
      "Max wait in ms (0 to 60000, default 10000). Set it to the last result's suggested_next_wait_ms value.",
    );
  });

  /** A running job that produced nothing this call — the silent case. */
  function silentObservation(id: string): BackgroundExecutionObservation {
    return {
      id,
      command: 'npm',
      status: 'running',
      pid: 1,
      startedAt: Date.now(),
      finishedAt: undefined,
      exitCode: null,
      error: undefined,
      stdout: '',
      stderr: '',
      stdoutStart: 0,
      stderrStart: 0,
      stdoutEnd: 0,
      stderrEnd: 0,
      stdoutOldest: 0,
      stderrOldest: 0,
      stdoutDropped: 0,
      stderrDropped: 0,
    } as BackgroundExecutionObservation;
  }

  it('tells a silent job to pass the suggested number as wait_ms', async () => {
    vi.spyOn(backgroundExecutionManager, 'observe').mockResolvedValue(
      silentObservation('exec-silent'),
    );
    const raw = await makeMonitorExecutionTool().handler({
      execution_id: 'exec-silent',
      wait_ms: 20_000,
    });
    const parsed = JSON.parse(String(raw)) as {
      suggested_next_wait_ms: number;
      silence_note: string;
    };
    expect(parsed.suggested_next_wait_ms).toBe(40_000);
    expect(parsed.silence_note).toBe(
      'No new output while still running. Silence is not evidence the job is stuck — many programs draw progress with a carriage return, which never reaches a pipe. Pass 40000 as wait_ms on your next call, and check progress by listing the destination directory recursively and watching a file GROW: downloads and archives write to a .part / .incomplete / .tmp file below the destination, not to the final path.',
    );
  });

  // The note is advice for a poll that came up empty, so it stays off a job that
  // is still producing output: there the suggestion resets to the default and
  // telling the caller to wait longer would be the wrong instruction.
  it('stays off a job that is still writing', async () => {
    vi.spyOn(backgroundExecutionManager, 'observe').mockResolvedValue({
      ...silentObservation('exec-chatty'),
      stdout: 'still going',
      stdoutEnd: 'still going'.length,
    } as BackgroundExecutionObservation);
    const chatty = JSON.parse(
      String(
        await makeMonitorExecutionTool().handler({ execution_id: 'exec-chatty', wait_ms: 20_000 }),
      ),
    ) as { silence_note?: string; suggested_next_wait_ms: number };
    expect(chatty.silence_note).toBeUndefined();
    expect(chatty.suggested_next_wait_ms).toBe(10_000);
  });
});
