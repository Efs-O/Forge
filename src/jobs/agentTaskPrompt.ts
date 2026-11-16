import type { JobStore } from './JobStore';
import type { JobFile } from './jobSchema';
import type { AgentTaskAction } from './agentTask';

/**
 * A 24-hour timestamp in the machine's own time zone. Nothing here pins a
 * region: the shape (ISO-style date, `h23` clock) is fixed by the format
 * options, while the clock the stamp reads is wherever this machine says it is.
 */
export function formatLocalDateTime(epochMs: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values['year']}-${values['month']}-${values['day']} ${values['hour']}:${values['minute']}`;
}

/** The time zone `formatLocalDateTime` prints in, named so a report can say so. */
export function localTimeZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The first line of every scheduled job turn. Exported because it outlives the
 * job: `JobStore.delete` removes the job and the conversation id in its state,
 * while the chat and its first line stay, so the daily retitle job recognizes a
 * job's chat from this text (`src/jobs/retitleCandidates.ts`).
 */
export const JOB_TASK_PROMPT_MARKER = 'Scheduled task for job "';

export async function buildAgentTaskPrompt(
  store: JobStore,
  jobFile: JobFile,
  action: AgentTaskAction,
): Promise<string> {
  const { job, state } = jobFile;
  const runTime = formatLocalDateTime(Date.now());
  const runs = await store.readRuns(job.id);
  const recent = runs.slice(-3);
  const runLines = recent.length
    ? recent.map((row) => `- ${new Date(row.at).toLocaleString()}: ${row.outcome} — ${row.summary}`)
    : ['(no earlier runs)'];
  const parts = [
    `${JOB_TASK_PROMPT_MARKER}${job.name}":`,
    `Scheduled run time: ${runTime} (${localTimeZoneName()}, 24-hour format).`,
    '',
    action.task,
    '',
    `Check observation: ${state.last_observation ?? '(none)'}`,
    '',
    `Last ${recent.length} run(s):`,
    ...runLines,
    '',
    'The facts in this message are current; where they disagree with anything ' +
      'earlier in this chat or its compaction summary, these win.',
    '',
    `You are running unattended as scheduled job "${job.name}". Nobody will answer ` +
      'questions or approvals. Dangerous actions will be denied. End your final ' +
      'message with exactly one line:',
    '`RESULT: ok | no_change | failed — <one sentence>`',
  ];
  return parts.join('\n');
}

/**
 * What a RESULT line may say. `updated` (a success that changed something)
 * arrives as `ok`; `skipped` means the turn ran but did not act, so the change
 * the check reported is still pending. Anything else counts as a failure.
 */
export type ResultKind = 'ok' | 'no_change' | 'skipped' | 'failed';

/**
 * Parse the `RESULT:` line (and an optional `RESTART:` line) from final text.
 *
 * The contract asks for `RESULT: ok | no_change | failed — <one sentence>`, but
 * a task that names its own kinds makes the agent copy those words: the Maya
 * updater ends its log with `RESULT: updated - engine rebuilt`, and its task
 * text says "copied from the script", so the turn sent `updated` and `skipped`
 * with an ASCII dash. Both wordings are accepted, and the kind word is taken
 * out of the sentence either way — leaving it in put `failed - ` inside every
 * failure summary and a status prefix in front of every success one.
 */
export function parseResult(finalText: string): {
  kind: ResultKind;
  sentence: string;
  restart: boolean;
} {
  const restart = /\bRESTART:\s*yes\b/i.test(finalText);
  const line = finalText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^RESULT:\s*/i.test(l));
  if (!line) {
    return {
      kind: 'failed',
      sentence: 'agent ended without a RESULT line',
      restart,
    };
  }
  const raw = line.replace(/^RESULT:\s*/i, '').trim();
  // Split on the FIRST dash that separates the kind from the sentence, in
  // either dash family: an ASCII one is what a script's own RESULT line uses,
  // and the sentence keeps everything after it, dashes and all.
  const parts = raw.split(/\s(?:[—–-])\s/);
  const head = (parts[0] ?? '').trim();
  const sentence = (parts.length > 1 ? parts.slice(1).join(' - ') : '').trim() || raw;
  const word = head.toLowerCase().replace(/[-_]/g, '');
  let kind: ResultKind;
  if (word.startsWith('nochange')) kind = 'no_change';
  else if (word.startsWith('skip')) kind = 'skipped';
  else if (word.startsWith('ok') || word.startsWith('updated')) kind = 'ok';
  else kind = 'failed';
  return { kind, sentence, restart };
}
