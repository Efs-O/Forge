import { describe, expect, it } from 'vitest';
import { isDue, jsDayToWeekday, nextDue, wakeTimesFor } from '../../src/jobs/schedule';
import type { Job, JobState } from '../../src/jobs/jobSchema';

/** A minimal enabled job with a given schedule. */
function job(schedule: Job['schedule']): Job {
  return {
    version: 1,
    id: 'j',
    name: 'J',
    enabled: true,
    wake: true,
    after: 'stay_awake',
    schedule,
    check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
    on_change: { kind: 'notify' },
    action: null,
    created_at: 0,
    updated_at: 0,
  };
}

const WAKE_LEAD_MS = 120_000;

describe('nextDue', () => {
  it('interval: from + minutes', () => {
    // A UTC instant so the assertion is timezone-independent.
    const from = new Date('2026-01-01T10:00:00Z');
    const due = nextDue({ kind: 'interval', minutes: 15 }, from);
    expect(due.toISOString()).toBe('2026-01-01T10:15:00.000Z');
  });

  it('daily: same day when still ahead', () => {
    const from = new Date('2026-01-01T05:00:00');
    const due = nextDue({ kind: 'daily', at: '06:00' }, from);
    expect(due.getHours()).toBe(6);
    expect(due.getMinutes()).toBe(0);
    expect(due.toDateString()).toBe(from.toDateString());
  });

  it('daily: next day when already past', () => {
    const from = new Date('2026-01-01T07:00:00');
    const due = nextDue({ kind: 'daily', at: '06:00' }, from);
    expect(due.getHours()).toBe(6);
    expect(due.toDateString()).not.toBe(from.toDateString());
  });

  it('weekly: next occurrence on any of the wanted weekdays', () => {
    // 2026-01-01 is a Thursday. Next Friday is 2026-01-02.
    const from = new Date('2026-01-01T12:00:00');
    const due = nextDue({ kind: 'weekly', days: ['Fri'], at: '06:00' }, from);
    expect(jsDayToWeekday(due.getDay())).toBe('Fri');
    expect(due.getHours()).toBe(6);
  });

  it('weekly: a wanted weekday earlier today still fires today', () => {
    // 2026-01-01 is a Thursday, 12:00. A Thursday 18:00 job is still ahead.
    const from = new Date('2026-01-01T12:00:00');
    const due = nextDue({ kind: 'weekly', days: ['Thu'], at: '18:00' }, from);
    expect(jsDayToWeekday(due.getDay())).toBe('Thu');
    expect(due.toDateString()).toBe(from.toDateString());
  });

  it('weekly: a wanted weekday already past today rolls to the next week', () => {
    // 2026-01-01 is a Thursday, 19:00. A Thursday 06:00 job is past today.
    const from = new Date('2026-01-01T19:00:00');
    const due = nextDue({ kind: 'weekly', days: ['Thu'], at: '06:00' }, from);
    expect(jsDayToWeekday(due.getDay())).toBe('Thu');
    expect(due.toDateString()).not.toBe(from.toDateString());
  });
});

describe('wakeTimesFor', () => {
  it('shifts a daily wake earlier by the lead time', () => {
    const now = new Date('2026-01-01T12:00:00');
    const wakes = wakeTimesFor([job({ kind: 'daily', at: '06:00' })], now, WAKE_LEAD_MS);
    // Next daily 06:00 is tomorrow; minus 2 min lead = 05:58.
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.hour).toBe(5);
    expect(wakes[0]!.minute).toBe(58);
    expect(wakes[0]!.days).toBe('daily');
  });

  it('shifts a weekly 00:01 job across midnight to the preceding weekday', () => {
    // 2026-01-01 is a Thursday. A Friday 00:01 job's next due is 2026-01-02
    // 00:01; minus a 2-min lead is 2026-01-01 23:59, i.e. the preceding day
    // (Thursday), so the wake must be registered on Thursday.
    const now = new Date('2026-01-01T12:00:00');
    const wakes = wakeTimesFor([job({ kind: 'weekly', days: ['Fri'], at: '00:01' })], now, WAKE_LEAD_MS);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.hour).toBe(23);
    expect(wakes[0]!.minute).toBe(59);
    expect(wakes[0]!.days).toEqual(['Thu']);
  });

  it('deduplicates two jobs due at the same minute', () => {
    const now = new Date('2026-01-01T12:00:00');
    const a = job({ kind: 'daily', at: '06:00' });
    const b = job({ kind: 'daily', at: '06:00' });
    const wakes = wakeTimesFor([a, b], now, WAKE_LEAD_MS);
    expect(wakes).toHaveLength(1);
  });

  it('keeps every weekly weekday after shifting across midnight', () => {
    const now = new Date('2026-01-01T12:00:00');
    const wakes = wakeTimesFor(
      [job({ kind: 'weekly', days: ['Mon', 'Fri'], at: '00:01' })],
      now,
      WAKE_LEAD_MS,
    );
    expect(wakes).toEqual([{ hour: 23, minute: 59, days: ['Thu', 'Sun'] }]);
  });

  it('does not create an invented daily wake for an interval job', () => {
    expect(wakeTimesFor([job({ kind: 'interval', minutes: 15 })], new Date(), WAKE_LEAD_MS)).toEqual([]);
  });

  it('ignores disabled and non-wake jobs', () => {
    const now = new Date('2026-01-01T12:00:00');
    const disabled = { ...job({ kind: 'daily', at: '06:00' }), enabled: false };
    const noWake = { ...job({ kind: 'daily', at: '07:00' }), wake: false };
    const wake = { ...job({ kind: 'daily', at: '08:00' }), wake: true };
    const wakes = wakeTimesFor([disabled, noWake, wake], now, WAKE_LEAD_MS);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.hour).toBe(7); // 08:00 - 2 min
  });
});

describe('isDue', () => {
  const state = (next_due_at: number | null): JobState => ({
    last_run_at: null,
    last_ok_at: null,
    last_observation: null,
    consecutive_failures: 0,
    next_due_at,
    conversation_id: null,
    summary_pending: false,
  });

  it('a job with no next_due_at is due (first run)', () => {
    expect(isDue(state(null), new Date('2026-01-01T00:00:00'))).toBe(true);
  });

  it('a job is due when now is at or past next_due_at', () => {
    const due = new Date('2026-01-01T06:00:00').getTime();
    expect(isDue(state(due), new Date('2026-01-01T06:00:00'))).toBe(true);
    expect(isDue(state(due), new Date('2026-01-01T06:00:01'))).toBe(true);
    expect(isDue(state(due), new Date('2026-01-01T05:59:59'))).toBe(false);
  });
});
