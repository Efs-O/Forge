import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompactionEvent } from '../../src/sidebar/CompactionService';
import { CompactionNoticeBuffer } from '../../src/remote/compactionNoticeBuffer';
import {
  compactionAggregationText,
  remoteCompactionNotice,
} from '../../src/remote/remoteCompactionNotice';

afterEach(() => {
  vi.useRealTimers();
});

function event(over: Partial<CompactionEvent> = {}): CompactionEvent {
  return {
    conversationId: 'c1',
    phase: 'finished',
    outcome: 'compacted',
    trigger: 'auto',
    ...over,
  };
}

describe('remoteCompactionNotice (aggregated policy)', () => {
  it('sends nothing for the started phase — aggregation replaces it', () => {
    expect(remoteCompactionNotice(event({ phase: 'started', outcome: undefined }))).toBeUndefined();
  });

  it('sends nothing for a completed compaction — the buffer aggregates it', () => {
    expect(remoteCompactionNotice(event({ outcome: 'compacted' }))).toBeUndefined();
  });

  it('sends nothing for a skipped compaction', () => {
    expect(remoteCompactionNotice(event({ outcome: 'skipped' }))).toBeUndefined();
  });

  it('reports a failed compaction immediately', () => {
    expect(remoteCompactionNotice(event({ outcome: 'failed' }))).toBe('Forge: compaction failed.');
  });

  it('suppresses non-auto triggers (manual /compact has its own progress)', () => {
    expect(remoteCompactionNotice(event({ trigger: 'remote', outcome: 'failed' }))).toBeUndefined();
    expect(remoteCompactionNotice(event({ trigger: 'sidebar', outcome: 'failed' }))).toBeUndefined();
  });
});

describe('compactionAggregationText', () => {
  it('keeps the singular wording for one compaction', () => {
    expect(compactionAggregationText(1)).toBe('Forge: compaction complete.');
  });

  it('collapses several into a single count', () => {
    expect(compactionAggregationText(5)).toBe('Forge: 5 compactions complete.');
  });
});

describe('CompactionNoticeBuffer', () => {
  function makeBuffer(deliver: (conv: string, text: string) => Promise<unknown> = vi.fn()) {
    const onError = vi.fn();
    const buffer = new CompactionNoticeBuffer(deliver, onError, 3000);
    return { buffer, deliver, onError };
  }

  it('flushes one aggregated message after the timer, not one per compaction', async () => {
    vi.useFakeTimers();
    const { buffer, deliver } = makeBuffer();
    buffer.record('c1');
    buffer.record('c1');
    buffer.record('c1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('c1', 'Forge: 3 compactions complete.');
  });

  it('resets the timer on each record', async () => {
    vi.useFakeTimers();
    const { buffer, deliver } = makeBuffer();
    buffer.record('c1');
    await vi.advanceTimersByTimeAsync(2999);
    buffer.record('c1');
    await vi.advanceTimersByTimeAsync(2999);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('c1', 'Forge: 2 compactions complete.');
  });

  it('flushes eagerly when asked (pre-notify), clearing the timer', async () => {
    vi.useFakeTimers();
    const { buffer, deliver } = makeBuffer();
    buffer.record('c1');
    const text = await buffer.flush('c1');
    expect(text).toBe('Forge: compaction complete.');
    expect(deliver).toHaveBeenCalledTimes(1);
    // The timer was cleared: advancing time sends nothing more.
    await vi.advanceTimersByTimeAsync(5000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent flushes and records arriving during delivery', async () => {
    let release!: () => void;
    let calls = 0;
    const deliver = vi.fn(
      () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve();
      },
    );
    const { buffer } = makeBuffer(deliver);
    buffer.record('c1');
    const first = buffer.flush('c1');
    const second = buffer.flush('c1');
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    buffer.record('c1');
    release();
    await Promise.all([first, second]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenNthCalledWith(1, 'c1', 'Forge: compaction complete.');
    expect(deliver).toHaveBeenNthCalledWith(2, 'c1', 'Forge: compaction complete.');
  });

  it('returns undefined and sends nothing when there is no pending count', async () => {
    const { buffer, deliver } = makeBuffer();
    await expect(buffer.flush('c1')).resolves.toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('keeps conversations separate', async () => {
    vi.useFakeTimers();
    const { buffer, deliver } = makeBuffer();
    buffer.record('c1');
    buffer.record('c2');
    buffer.record('c2');
    await vi.advanceTimersByTimeAsync(3000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledWith('c1', 'Forge: compaction complete.');
    expect(deliver).toHaveBeenCalledWith('c2', 'Forge: 2 compactions complete.');
  });

  it('starts a fresh count after a flush', async () => {
    vi.useFakeTimers();
    const { buffer, deliver } = makeBuffer();
    buffer.record('c1');
    await buffer.flush('c1');
    buffer.record('c1');
    buffer.record('c1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenLastCalledWith('c1', 'Forge: 2 compactions complete.');
  });

  it('reports delivery errors through onError and still clears the count', async () => {
    vi.useFakeTimers();
    const failing = vi.fn(() => Promise.reject(new Error('channel down')));
    const { buffer, onError } = makeBuffer(failing);
    buffer.record('c1');
    await vi.advanceTimersByTimeAsync(3000);
    expect(onError).toHaveBeenCalledWith('channel down');
    // Count was consumed: nothing is re-sent later.
    await vi.advanceTimersByTimeAsync(3000);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('dispose drops pending counts and clears timers', async () => {
    vi.useFakeTimers();
    const { buffer, deliver } = makeBuffer();
    buffer.record('c1');
    buffer.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(deliver).not.toHaveBeenCalled();
    await expect(buffer.flush('c1')).resolves.toBeUndefined();
    expect(buffer.record('c1')).toBeUndefined(); // no throw, no-op
    await vi.advanceTimersByTimeAsync(5000);
    expect(deliver).not.toHaveBeenCalled();
  });
});
