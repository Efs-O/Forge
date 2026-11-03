import { describe, expect, it } from 'vitest';
import { defaultState } from '../../src/jobs/JobStore';
import { describeSchedule, formatWhen, lastRunOutcome, truncate } from '../../src/jobs/jobDescribe';
import { JobStateSchema } from '../../src/jobs/jobSchema';

/** A fixed clock so a boundary test cannot drift with the machine's timezone. */
const NOW = new Date('2026-10-30T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** `at` is `now` minus `ago`, so each case reads as the elapsed time it names. */
const ago = (ms: number): number => NOW.getTime() - ms;

describe('formatWhen — the shared relative formatter', () => {
  it.each([
    ['20s', ago(20_000), 'just now'],
    ['100s', ago(100_000), '2m ago'],
    ['5m', ago(5 * MIN), '5m ago'],
    ['59m', ago(59 * MIN), '59m ago'],
    ['61m', ago(61 * MIN), '1h ago'],
    ['23h', ago(23 * HOUR), '23h ago'],
    ['25h', ago(25 * HOUR), '1d ago'],
    ['6d', ago(6 * DAY), '6d ago'],
  ])('reads %s as its own unit', (_label, at, expected) => {
    expect(formatWhen(at, NOW)).toBe(expected);
  });

  // Five minutes ago used to read `0h ago`, because the first unit that existed
  // was hours and anything under an hour rounded down to zero. The sessions
  // panel shows a job's last run every time the panel opens, so a run that
  // finished two minutes ago must not read as having finished this hour.
  it('does not round a minute-scale gap down to `0h ago`', () => {
    expect(formatWhen(ago(5 * MIN), NOW)).toBe('5m ago');
    expect(formatWhen(ago(5 * MIN), NOW)).not.toContain('0h');
  });

  it('phrases a future time as a future time, not as a past one', () => {
    expect(formatWhen(NOW.getTime() + 2 * MIN, NOW)).toBe('in 2m');
    expect(formatWhen(NOW.getTime() + 2 * HOUR, NOW)).toBe('in 2h');
    expect(formatWhen(NOW.getTime() + 3 * DAY, NOW)).toBe('in 3d');
    // Under half a minute reads as now. The formatter rounds to the nearest\n    // unit, so 45 seconds away is already `in 1m` — the same rounding that\n    // makes 59 minutes read `1h ago`.\n    expect(formatWhen(NOW.getTime() + 25_000, NOW)).toBe('now');\n    expect(formatWhen(NOW.getTime() + 45_000, NOW)).toBe('in 1m');
  });

  // Past a week the relative wording stops being useful, so it falls back to a
  // date. Asserting against the same call keeps the test honest about which
  // locale the host is running in.
  it('gives a plain date past a week', () => {
    const at = ago(10 * DAY);
    expect(formatWhen(at, NOW)).toBe(new Date(at).toLocaleDateString());
    expect(formatWhen(at, NOW)).not.toMatch(/ago$/);
  });
});

describe('describeSchedule', () => {
  it('names the schedule the way every surface shows it', () => {
    expect(describeSchedule({ kind: 'daily', at: '08:20' })).toBe('daily at 08:20');
    expect(describeSchedule({ kind: 'interval', minutes: 30 })).toBe('every 30 min');
  });
});

describe('lastRunOutcome', () => {
  const state = (over: Record<string, unknown>) =>
    JobStateSchema.parse({ ...defaultState(), ...over });

  it('says so when a job has never run', () => {
    expect(lastRunOutcome(state({}))).toBe('no runs yet');
  });

  it('counts the streak while a job keeps failing', () => {
    expect(lastRunOutcome(state({ last_run_at: 1, consecutive_failures: 3 }))).toBe('failing ×3');
  });

  it('reads ok once the last run went through', () => {
    expect(lastRunOutcome(state({ last_run_at: 1, consecutive_failures: 0 }))).toBe('ok');
  });
});

describe('truncate', () => {
  it('keeps a short string whole', () => {
    expect(truncate('nothing to see', 120)).toBe('nothing to see');
  });

  it('cuts to the limit and marks that it cut', () => {
    const long = 'x'.repeat(200);
    const cut = truncate(long, 120);
    expect(cut).toHaveLength(120);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toBe(`${long.slice(0, 119)}…`);
  });
});
