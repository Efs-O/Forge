/**
 * The machine's local calendar and wall clock, as the model is allowed to see
 * them.
 *
 * Two consumers, two different rules, and the split is the point:
 *
 * - `localDate()` goes in the system prompt (TemplateEngine). DATE only. The
 *   system prompt is the KV cache's prefix, so anything in it that ticks
 *   re-processes the whole prompt every turn; a date moves once a day, at an
 *   hour nobody is mid-turn.
 * - `localTimeOfDay()` goes in a TOOL RESULT, never the prompt. A tool result
 *   is appended after everything already cached, so a clock there costs no
 *   re-evaluation, and it arrives at the one moment it is true.
 *
 * Why a clock reaches the model at all: on 2026-09-05 an agent asked to report
 * hourly on a benchmark chained `wait` calls and posted a "60-min check" seven
 * minutes in. It had called `wait(360)` twice and had nothing to check its
 * count against -- `Waited 360s.` is a duration, not a position in time, and
 * the prompt told it not to ask the shell for the clock. Counting your own
 * sleeps is the only way to keep time when nothing reports it, and a model
 * that miscounts once has no way to notice.
 */

const pad = (value: number): string => String(value).padStart(2, '0');

/** Today, local, as `YYYY-MM-DD`. Never carries a time -- see above. */
export function localDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The wall clock, local, as 24-hour `HH:MM`. No seconds: the coarsest form
 * that still answers "how long has this been going", and one that reads the
 * same as the timestamps the user sees on their own messages.
 */
export function localTimeOfDay(now: Date = new Date()): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
