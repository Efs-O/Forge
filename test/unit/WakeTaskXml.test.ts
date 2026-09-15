import { describe, expect, it } from 'vitest';
import {
  oneShotTaskXml,
  parseScheduledWakes,
  renderRecurringTriggers,
  scheduledWakeTaskXml,
  type RecurringWake,
} from '../../src/system/wakeTaskXml';

describe('oneShotTaskXml', () => {
  const when = new Date(2026, 8, 15, 7, 0, 0);

  it('renders a TimeTrigger with EndBoundary one minute after start', () => {
    const xml = oneShotTaskXml(when);
    expect(xml).toContain('<TimeTrigger>');
    expect(xml).toContain('<StartBoundary>2026-09-15T07:00:00</StartBoundary>');
    expect(xml).toContain('<EndBoundary>2026-09-15T07:01:00</EndBoundary>');
  });

  it('renders the interactive-token principal, not SYSTEM', () => {
    const xml = oneShotTaskXml(when);
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).not.toContain('S-1-5-18');
    expect(xml).not.toContain('<UserId>');
  });

  it('includes DeleteExpiredTaskAfter so the task cleans itself up', () => {
    expect(oneShotTaskXml(when)).toContain('<DeleteExpiredTaskAfter>PT1M</DeleteExpiredTaskAfter>');
  });

  it('uses local time with no timezone suffix', () => {
    const xml = oneShotTaskXml(when);
    // No Z or offset: Task Scheduler reads StartBoundary as local.
    expect(xml).not.toContain('T07:00:00Z');
    expect(xml).not.toContain('+00:00');
  });
});

describe('scheduledWakeTaskXml', () => {
  it('renders a CalendarTrigger per distinct wake, no EndBoundary or DeleteExpiredTaskAfter', () => {
    const wakes: RecurringWake[] = [
      { hour: 6, minute: 0, days: 'daily' },
      { hour: 9, minute: 30, days: ['Mon', 'Wed', 'Fri'] },
    ];
    const xml = scheduledWakeTaskXml(wakes);
    expect(xml.match(/<CalendarTrigger>/g)).toHaveLength(2);
    expect(xml).not.toContain('<EndBoundary>');
    expect(xml).not.toContain('<DeleteExpiredTaskAfter>');
  });

  it('renders the interactive-token principal, not SYSTEM', () => {
    const xml = scheduledWakeTaskXml([{ hour: 6, minute: 0, days: 'daily' }]);
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).not.toContain('S-1-5-18');
  });

  it('renders a daily ScheduleByDay with DaysInterval 1', () => {
    const xml = scheduledWakeTaskXml([{ hour: 6, minute: 0, days: 'daily' }]);
    expect(xml).toContain('<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>');
  });

  it('renders weekday wakes as ScheduleByWeek with days in canonical order', () => {
    // Input order is deliberately non-canonical; the output must be sorted.
    const xml = scheduledWakeTaskXml([{ hour: 9, minute: 30, days: ['Fri', 'Mon', 'Wed'] }]);
    expect(xml).toContain('<DaysOfWeek>MonWedFri</DaysOfWeek>');
  });

  it('does not mutate the input days array', () => {
    const days = ['Fri', 'Mon', 'Wed'] as const;
    scheduledWakeTaskXml([{ hour: 9, minute: 30, days: [...days] }]);
    expect([...days]).toEqual(['Fri', 'Mon', 'Wed']);
  });

  it('renders local-time boundaries with no timezone suffix', () => {
    const xml = scheduledWakeTaskXml([{ hour: 6, minute: 0, days: 'daily' }]);
    expect(xml).toMatch(/<StartBoundary>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}<\/StartBoundary>/);
    expect(xml).not.toContain('T06:00:00Z');
  });
});

describe('renderRecurringTriggers', () => {
  it('renders one CalendarTrigger per wake', () => {
    const xml = renderRecurringTriggers([
      { hour: 6, minute: 0, days: 'daily' },
      { hour: 12, minute: 0, days: 'daily' },
      { hour: 18, minute: 0, days: ['Sat'] },
    ]);
    expect(xml.match(/<CalendarTrigger>/g)).toHaveLength(3);
  });

  it('merges wakes at the same clock time into one trigger', () => {
    const xml = renderRecurringTriggers([
      { hour: 6, minute: 0, days: ['Mon', 'Wed'] },
      { hour: 6, minute: 0, days: ['Wed', 'Fri'] },
    ]);
    expect(xml.match(/<CalendarTrigger>/g)).toHaveLength(1);
    expect(xml).toContain('<DaysOfWeek>MonWedFri</DaysOfWeek>');
  });

  it('rejects invalid recurring wake definitions before rendering XML', () => {
    expect(() => scheduledWakeTaskXml([{ hour: 24, minute: 0, days: 'daily' }])).toThrow(/hour/);
    expect(() => scheduledWakeTaskXml([{ hour: 6, minute: 0, days: [] }])).toThrow(/weekday/);
  });
});

describe('parseScheduledWakes', () => {
  it('parses a daily wake back to the same shape', () => {
    const xml = scheduledWakeTaskXml([{ hour: 6, minute: 0, days: 'daily' }]);
    const parsed = parseScheduledWakes(xml);
    expect(parsed).toEqual([{ hour: 6, minute: 0, days: 'daily' }]);
  });

  it('parses weekday wakes back to the same shape', () => {
    const xml = scheduledWakeTaskXml([{ hour: 9, minute: 30, days: ['Mon', 'Wed', 'Fri'] }]);
    const parsed = parseScheduledWakes(xml);
    expect(parsed).toEqual([{ hour: 9, minute: 30, days: ['Mon', 'Wed', 'Fri'] }]);
  });

  it('parses multiple wakes', () => {
    const xml = scheduledWakeTaskXml([
      { hour: 6, minute: 0, days: 'daily' },
      { hour: 9, minute: 30, days: ['Mon', 'Fri'] },
    ]);
    const parsed = parseScheduledWakes(xml);
    expect(parsed).toHaveLength(2);
    expect(parsed![0]).toEqual({ hour: 6, minute: 0, days: 'daily' });
    expect(parsed![1]).toEqual({ hour: 9, minute: 30, days: ['Mon', 'Fri'] });
  });

  it('returns null for empty input', () => {
    expect(parseScheduledWakes('')).toBeNull();
    expect(parseScheduledWakes('   ')).toBeNull();
  });

  it('returns null when the XML has no CalendarTrigger', () => {
    const xml = oneShotTaskXml(new Date(2026, 8, 15, 7, 0, 0));
    expect(parseScheduledWakes(xml)).toBeNull();
  });

  it('rejects malformed calendar triggers instead of inventing a schedule', () => {
    expect(() => parseScheduledWakes('<CalendarTrigger><ScheduleByWeek /></CalendarTrigger>')).toThrow(
      /StartBoundary/,
    );
  });
});
