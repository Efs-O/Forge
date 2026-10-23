import type { JobFile } from '../jobs/jobSchema';
import { describeSchedule, formatWhen } from '../jobs/jobDescribe';
import { escapeTelegramHtml } from './telegramHtml';
import { telegramJobButton } from './TelegramJobButtons';
import { telegramCloseButton } from './TelegramHelpButtons';

export interface RemoteJobReport {
  html: string;
  plain: string;
  buttons: Array<Array<{ text: string; callbackData: string }>>;
}

/** Telegram `/jobs` list; numbers carry their position and current job identity. */
export function renderRemoteJobList(all: readonly JobFile[], now = new Date()): RemoteJobReport {
  const lines = all.map((file, index) => {
    const { job, state } = file;
    const last = state.last_run_at === null ? 'never' : formatWhen(state.last_run_at, now);
    const outcome =
      state.last_run_at === null
        ? 'no runs yet'
        : state.consecutive_failures > 0
          ? `failing ×${state.consecutive_failures}`
          : 'ok';
    const next = !job.enabled
      ? 'paused'
      : state.next_due_at === null
        ? 'not scheduled'
        : `next ${formatWhen(state.next_due_at, now)}`;
    const meta = `${describeSchedule(job.schedule)} · last ${last} (${outcome}) · ${next}`;
    const htmlOutcome =
      state.consecutive_failures > 0 && state.last_run_at !== null
        ? `(<b>${escapeTelegramHtml(outcome)}</b>)`
        : `(${escapeTelegramHtml(outcome)})`;
    return {
      html: `<b>${index + 1}.</b> ${escapeTelegramHtml(clip(job.name, 80))}\n${escapeTelegramHtml(describeSchedule(job.schedule))} · last ${escapeTelegramHtml(last)} ${htmlOutcome} · ${escapeTelegramHtml(next)}`,
      plain: `${index + 1}. ${clip(job.name, 80)}\n${meta}`,
      button: telegramJobButton(String(index + 1), index, job.id),
    };
  });
  const buttons: RemoteJobReport['buttons'] = [];
  for (let offset = 0; offset < lines.length; offset += 5) {
    buttons.push(lines.slice(offset, offset + 5).map((line) => line.button));
  }
  buttons.push([telegramCloseButton()]);
  return {
    html: `<b>Jobs</b> <i>· ${all.length}</i>\n\n${
      lines.length
        ? `${lines.map((line) => line.html).join('\n\n')}\n\n<i>Tap a number for its actions</i>`
        : 'No jobs.'
    }`,
    plain: `Jobs · ${all.length}\n\n${
      lines.length
        ? `${lines.map((line) => line.plain).join('\n\n')}\n\nUse /job <n|name> pause|resume|run|delete|chat.`
        : 'No jobs.'
    }`,
    buttons,
  };
}

/** Telegram job card, with action callbacks tied to the rendered list row. */
export function renderRemoteJobCard(
  file: JobFile,
  index: number,
  now = new Date(),
): RemoteJobReport {
  const { job, state } = file;
  const last = state.last_run_at === null ? 'never' : formatWhen(state.last_run_at, now);
  const next = !job.enabled
    ? 'paused'
    : state.next_due_at === null
      ? 'not scheduled'
      : formatWhen(state.next_due_at, now);
  const status = job.enabled ? 'enabled' : 'paused';
  const details = [
    `Schedule: ${describeSchedule(job.schedule)}`,
    `Status: ${status}`,
    `Last run: ${last}`,
    `Next: ${next}`,
  ].join('\n');
  const observation = state.last_observation
    ? `\n\n<b>Last observation</b>\n<blockquote expandable>${escapeBounded(state.last_observation, 2_800)}</blockquote>`
    : '';
  const buttons = [
    [telegramJobButton('▶ Run now', index, job.id, 'r')],
    [
      telegramJobButton(
        job.enabled ? '⏸ Pause' : '▶ Resume',
        index,
        job.id,
        job.enabled ? 'p' : 'u',
      ),
    ],
    [
      telegramJobButton('Chat', index, job.id, 'c'),
      telegramJobButton('Delete', index, job.id, 'd'),
      telegramJobButton('‹ Jobs', index, job.id, 'l'),
    ],
  ];
  buttons.push([telegramCloseButton()]);
  return {
    html: `<b>${escapeTelegramHtml(clip(job.name, 120))}</b>\n<pre>${escapeTelegramHtml(details)}</pre>${observation}`,
    plain: `${clip(job.name, 120)}\n${details}${state.last_observation ? `\n\nLast observation\n${state.last_observation}` : ''}`,
    buttons,
  };
}

function escapeBounded(value: string, maximumEscaped: number): string {
  let result = '';
  for (const character of value) {
    const escaped = escapeTelegramHtml(character);
    if (result.length + escaped.length > maximumEscaped - 1) return `${result}…`;
    result += escaped;
  }
  return result;
}

function clip(value: string, maximum: number): string {
  const chars = [...value];
  return chars.length <= maximum ? value : `${chars.slice(0, maximum - 1).join('')}…`;
}
