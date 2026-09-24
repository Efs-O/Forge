import type { JobStore } from './JobStore';
import type { JobFile } from './jobSchema';
import type { AgentTaskAction } from './agentTask';

/** A stable, locale-independent 24-hour timestamp for Athens job reports. */
export function formatAthensDateTime(epochMs: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Athens',
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

export async function buildAgentTaskPrompt(
  store: JobStore,
  jobFile: JobFile,
  action: AgentTaskAction,
): Promise<string> {
  const { job, state } = jobFile;
  const runTime = formatAthensDateTime(Date.now());
  const runs = await store.readRuns(job.id);
  const recent = runs.slice(-3);
  const runLines = recent.length
    ? recent.map((row) => `- ${new Date(row.at).toLocaleString()}: ${row.outcome} — ${row.summary}`)
    : ['(no earlier runs)'];
  const parts = [
    `Scheduled task for job "${job.name}":`,
    `Scheduled run time: ${runTime} (Europe/Athens, 24-hour format).`,
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

/** Parse the `RESULT:` line (and an optional `RESTART:` line) from final text. */
export function parseResult(finalText: string): {
  kind: 'ok' | 'no_change' | 'failed';
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
  const [head, ...rest] = raw.split('—');
  const sentence = (rest.length ? rest.join('—') : head).trim() || head.trim();
  const lower = raw.toLowerCase();
  let kind: 'ok' | 'no_change' | 'failed';
  if (lower.startsWith('no_change')) kind = 'no_change';
  else if (lower.startsWith('ok')) kind = 'ok';
  else kind = 'failed';
  return { kind, sentence, restart };
}
