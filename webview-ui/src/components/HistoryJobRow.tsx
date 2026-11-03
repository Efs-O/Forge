/**
 * One job row: its name, its schedule (or `paused`, or `◌ Running` while its
 * `agent_task` turn is streaming in this window), and its last recorded run.
 *
 * Every word arrives already formatted from `jobDescribe.ts`, so the panel,
 * `manage_jobs` and Telegram `/jobs` describe the same job the same way, and a
 * row stays a projection of the store rather than a second copy of it. The dot
 * beside the name is the one thing the text cannot say on its own: a job that
 * failed its last run and one that never ran both read as a line of words, and
 * only the dot tells them apart at a glance.
 */
import type { ReactElement } from 'react';
import type { JobPanelMeta } from '../../../src/sidebar/messageBridge';
import { formatWhen } from '../../../src/jobs/jobDescribe';
import { jobStatusOf } from '../historyFilter';

interface HistoryJobRowProps {
  job: JobPanelMeta;
  /** The minute this panel last re-drew its relative times. */
  now: Date;
  /** True only for the job whose turn this window is streaming. */
  running: boolean;
  onOpen: (id: string) => void;
}

export function HistoryJobRow({ job, now, running, onOpen }: HistoryJobRowProps): ReactElement {
  const status = jobStatusOf(job, running);
  const last = job.lastRun
    ? // The streak count is the one thing the last run's own line cannot say:
      // failing three runs in a row reads differently from failing once.
      `${job.lastRun.outcome} — ${job.lastRun.detail} · ${formatWhen(job.lastRun.at, now)}${
        job.consecutiveFailures > 0 ? ` (failing ×${job.consecutiveFailures})` : ''
      }`
    : job.lastOutcomeLabel;
  return (
    <div className={`history-item-row history-job-row history-job-status-${status}`}>
      <button
        type="button"
        className="history-item"
        onClick={() => onOpen(job.id)}
        /* The outcome line takes the row's own space, so the tooltip carries the
           whole thing: which job this is, and what its last run reported. A line
           cut short in a narrow panel still has somewhere to be read in full. */
        title={`${job.description}\n${last}`}
      >
        {/* The dot sits inside the title span here, not beside it: a job row
            stacks its lines (`.history-job-row .history-item` is a column), so a
            sibling would land on its own line above the name. It carries no
            text, so the row's name is still what a screen reader or a test
            reading the title gets. */}
        <span className="history-item-title">
          <span className={`history-row-dot history-row-dot--${status}`} aria-hidden="true" />
          {job.name}
        </span>
        <span className={`history-item-meta${running ? ' history-item-meta-running' : ''}`}>
          {running ? '◌ Running' : job.enabled ? job.schedule : `paused · ${job.schedule}`}
        </span>
        <span className="history-item-meta history-job-last">{last}</span>
      </button>
    </div>
  );
}
