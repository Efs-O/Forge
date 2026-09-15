/**
 * Pure XML rendering for Task Scheduler wake tasks.
 *
 * Split from `PowerControl` so the XML is testable without Windows: no
 * `schtasks`, no PowerShell, no extension host. Both task kinds (one-shot
 * `ForgeWakeTimer` and recurring `ForgeScheduledWake`) render through the
 * same settings block and principal, so they cannot drift apart.
 *
 * Both use the interactive-user `InteractiveToken` principal, not SYSTEM
 * (`S-1-5-18`). A1 proved the SYSTEM principal cannot be created from a
 * normal (non-elevated) VS Code session; the no-op `cmd /c exit` action does
 * not care who runs it.
 */

export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface RecurringWake {
  hour: number;
  minute: number;
  days: 'daily' | Weekday[];
}

const WEEKDAY_ORDER: readonly Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function validWake(wake: RecurringWake): void {
  if (
    !Number.isInteger(wake.hour) ||
    wake.hour < 0 ||
    wake.hour > 23 ||
    !Number.isInteger(wake.minute) ||
    wake.minute < 0 ||
    wake.minute > 59
  ) {
    throw new Error('Forge: recurring wake time must be an hour (0–23) and minute (0–59).');
  }
  if (wake.days !== 'daily' && wake.days.length === 0) {
    throw new Error('Forge: a weekly recurring wake must include at least one weekday.');
  }
}

/** One trigger per clock time; a daily wake subsumes any weekday wake at that time. */
function distinctWakes(wakes: readonly RecurringWake[]): RecurringWake[] {
  const byTime = new Map<string, RecurringWake>();
  for (const wake of wakes) {
    validWake(wake);
    const key = `${wake.hour}:${wake.minute}`;
    const current = byTime.get(key);
    if (!current || wake.days === 'daily') {
      byTime.set(key, {
        hour: wake.hour,
        minute: wake.minute,
        days: wake.days === 'daily' ? 'daily' : [...wake.days],
      });
    } else if (current.days !== 'daily') {
      byTime.set(key, {
        ...current,
        days: WEEKDAY_ORDER.filter((day) => current.days.includes(day) || wake.days.includes(day)),
      });
    }
  }
  return [...byTime.values()];
}

/** Local time, no timezone suffix: Task Scheduler reads `StartBoundary` as local. */
function localIso(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
  );
}

/**
 * The principal block. `InteractiveToken` means "run as whoever is logged in
 * at the time the task fires" — no stored credentials, no elevation needed to
 * create the task.
 */
export function renderPrincipal(): string {
  return [
    '  <Principals>',
    '    <Principal id="Author">',
    '      <LogonType>InteractiveToken</LogonType>',
    '    </Principal>',
    '  </Principals>',
  ].join('\n');
}

/**
 * Shared settings block. `WakeToRun=true` is the load-bearing attribute: it
 * tells the RTC to wake the machine to run the task. The task itself does
 * nothing (`cmd /c exit`); waking the machine to run it IS the effect.
 */
export function renderSettings(options: { deleteExpiredAfter?: string } = {}): string {
  const lines = [
    '  <Settings>',
    '    <WakeToRun>true</WakeToRun>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
  ];
  if (options.deleteExpiredAfter) {
    lines.push(
      `    <DeleteExpiredTaskAfter>${options.deleteExpiredAfter}</DeleteExpiredTaskAfter>`,
    );
  }
  lines.push('    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>');
  lines.push('    <Enabled>true</Enabled>');
  lines.push('  </Settings>');
  return lines.join('\n');
}

/** The no-op action: the wake is the point, not the task. */
export function renderAction(): string {
  return [
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>cmd.exe</Command>',
    '      <Arguments>/c exit</Arguments>',
    '    </Exec>',
    '  </Actions>',
  ].join('\n');
}

/**
 * One-shot `TimeTrigger` with `EndBoundary` = start + 1 min.
 * The `EndBoundary` and `DeleteExpiredTaskAfter` (in the full task XML) mean
 * the task cleans itself up after firing.
 */
export function renderOneShotTrigger(when: Date): string {
  const start = localIso(when);
  const end = localIso(new Date(when.getTime() + 60_000));
  return [
    '  <Triggers>',
    '    <TimeTrigger>',
    `      <StartBoundary>${start}</StartBoundary>`,
    `      <EndBoundary>${end}</EndBoundary>`,
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
  ].join('\n');
}

/**
 * One `CalendarTrigger` per distinct recurring wake time. Daily wakes use
 * `ScheduleByDay`; weekday wakes use `ScheduleByWeek` with the named days.
 * No `EndBoundary`, no `DeleteExpiredTaskAfter`: the task persists until
 * explicitly deleted (empty wake list).
 */
export function renderRecurringTriggers(wakes: readonly RecurringWake[]): string {
  const triggers = distinctWakes(wakes).map((wake) => {
    // StartBoundary is the next occurrence of this clock time. The task
    // scheduler repeats it on the schedule below; the boundary just needs to
    // be a valid future local timestamp.
    const now = new Date();
    const start = new Date(now);
    start.setHours(wake.hour, wake.minute, 0, 0);
    if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1);
    const boundary = localIso(start);

    const schedule =
      wake.days === 'daily'
        ? '      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>'
        : [
            '      <ScheduleByWeek>',
            `        <DaysOfWeek>${[...wake.days].sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b)).join('')}</DaysOfWeek>`,
            '        <WeeksInterval>1</WeeksInterval>',
            '      </ScheduleByWeek>',
          ].join('\n');

    return [
      '    <CalendarTrigger>',
      `      <StartBoundary>${boundary}</StartBoundary>`,
      '      <Enabled>true</Enabled>',
      schedule,
      '    </CalendarTrigger>',
    ].join('\n');
  });

  return ['  <Triggers>', ...triggers, '  </Triggers>'].join('\n');
}

/**
 * Full one-shot task XML for `ForgeWakeTimer`.
 * Has `EndBoundary` (in the trigger) and `DeleteExpiredTaskAfter=PT1M` (in
 * the settings) so the task deletes itself after firing.
 */
export function oneShotTaskXml(when: Date): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Forge one-shot wake timer. Wakes this machine so Forge and its remote transports come back online.</Description>',
    '  </RegistrationInfo>',
    renderOneShotTrigger(when),
    renderPrincipal(),
    renderSettings({ deleteExpiredAfter: 'PT1M' }),
    renderAction(),
    '</Task>',
  ].join('\n');
}

/**
 * Full recurring task XML for `ForgeScheduledWake`.
 * No `EndBoundary`, no `DeleteExpiredTaskAfter`: the task persists until
 * `setScheduledWakes([])` deletes it.
 */
export function scheduledWakeTaskXml(wakes: readonly RecurringWake[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Forge recurring wake timer for scheduled jobs. Wakes this machine at the job times.</Description>',
    '  </RegistrationInfo>',
    renderRecurringTriggers(wakes),
    renderPrincipal(),
    renderSettings(),
    renderAction(),
    '</Task>',
  ].join('\n');
}

/**
 * Parse the `schtasks /query /xml` output for `ForgeScheduledWake` and
 * reconstruct the `RecurringWake[]` schedule. Returns `null` when the task
 * does not exist or the XML has no `CalendarTrigger` elements.
 */
export function parseScheduledWakes(xml: string): RecurringWake[] | null {
  const trimmed = xml.trim();
  if (!trimmed) return null;
  const triggers = trimmed.match(/<CalendarTrigger>[\s\S]*?<\/CalendarTrigger>/g);
  if (!triggers) return null;

  return triggers.map((trigger) => {
    const boundary = /<StartBoundary>\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):\d{2}<\/StartBoundary>/.exec(
      trigger,
    );
    if (!boundary) {
      throw new Error('Forge: scheduled wake task has a CalendarTrigger without a StartBoundary.');
    }
    const hour = Number(boundary[1]);
    const minute = Number(boundary[2]);
    const isDaily = /<ScheduleByDay>/.test(trigger);
    const daysMatch = /<DaysOfWeek>([A-Za-z]+)<\/DaysOfWeek>/.exec(trigger);
    if (!isDaily && !daysMatch) {
      throw new Error('Forge: scheduled wake task has a weekly trigger without DaysOfWeek.');
    }
    const days: RecurringWake['days'] = isDaily ? 'daily' : parseWeekdays(daysMatch![1]);
    const wake = { hour, minute, days };
    validWake(wake);
    return wake;
  });
}

function parseWeekdays(text: string): Weekday[] {
  const result: Weekday[] = [];
  for (const day of WEEKDAY_ORDER) {
    if (text.includes(day)) result.push(day);
  }
  if (result.length === 0) throw new Error('Forge: scheduled wake task has no valid weekdays.');
  return result;
}
