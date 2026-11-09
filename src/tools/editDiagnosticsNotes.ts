/**
 * The sentences `editDiagnostics.ts` falls back on when the check it promised
 * did not happen.
 *
 * Split out on 2026-10-29 while fixing Claude's review of 096a2e77 (item 7): a
 * file this host will not open for checking now skips the wait, and saying "no
 * wait ran" meant the deadline had to become optional in every sentence that
 * quotes it. That is four functions of wording, and the file that also owns the
 * snapshot, the diff and the wait was at its 500-line gate. Wording lives here;
 * the decision about WHICH sentence is true stays in `editDiagnostics.ts`, and
 * the dependency runs one way only, so the two cannot form a cycle.
 */
import * as vscode from 'vscode';
import { formatDiagnosticLine } from './lspTools';
import type { ReportedProblem } from './editDiagnostics';

/** Errors and warnings only: `severity` below this is info or hint. */
const REPORTABLE_SEVERITY = 1;

/** The path as the rest of the result names it: workspace-relative when it can be. */
export function displayPath(writtenPath: string): string {
  try {
    const relative = vscode.workspace.asRelativePath(vscode.Uri.file(writtenPath), false);
    return relative === writtenPath ? writtenPath : relative;
  } catch {
    // A host with no workspace, or a stub `asRelativePath`: the absolute path
    // is still the right thing to name in the note.
    return writtenPath;
  }
}

/**
 * A check that never happened has to be named as one, not called a clean result.
 *
 * `deadlineMs` is undefined when no wait ran at all: a file this host will not
 * open is a file no service is going to report on, so waiting for a report that
 * cannot arrive spent seconds on a note that was already written. The sentence
 * then names no time, because there was none to name.
 */
export function notCheckedNote(
  writtenPath: string,
  aborted: boolean,
  deadlineMs: number | undefined,
): string {
  const checked = `The language service had not re-checked ${displayPath(writtenPath)}`;
  return (
    `${checked}${timeClause(aborted, deadlineMs)}, so this edit was not checked; ` +
    'call __code_intel_get_diagnostics on it if it matters.'
  );
}

/** Nothing ever reported on this file: the note may say only that much. */
export function notReportedNote(
  aborted: boolean,
  deadlineMs: number | undefined,
  reason?: string,
): string {
  // A reason with no wait is a different claim from a wait that produced
  // nothing: the file was never going to be reported on, and the seconds this
  // note used to quote were never spent. The model can act on the reason, so
  // the reason goes where the time used to be.
  const head =
    deadlineMs === undefined && reason !== undefined
      ? 'No language service checked this file'
      : `No language service reported on this file${timeClause(aborted, deadlineMs)}`;
  return (
    `${head}${reason ? `, because ${reason}` : ''}, so this edit could not be checked — ` +
    'that is not proof it is clean.'
  );
}

/** How long the service had, that the turn ended before it did, or nothing when no wait ran. */
function timeClause(aborted: boolean, deadlineMs?: number): string {
  if (deadlineMs === undefined) return '';
  return aborted ? ' before the turn was stopped' : ` within ${describeDuration(deadlineMs)}`;
}

/** The wait as a model reads it: 2 s, 1.5 s, 250 ms. */
function describeDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const seconds = ms / 1_000;
  return `${seconds % 1 === 0 ? String(seconds) : seconds.toFixed(1)} s`;
}

/** The note text, or '' when there is nothing to say. */
export function describeProblems(context: {
  beforeSeen: boolean;
  beforeProblems: readonly ReportedProblem[];
  afterProblems: readonly ReportedProblem[];
  /**
   * A diagnostics event naming this file arrived, so the service had a chance
   * to re-read it.
   */
  eventArrived: boolean;
  /** The wait ended because the call was stopped, not because time ran out. */
  aborted: boolean;
  /** How long the language service actually had, which the note has to state honestly; undefined when no wait ran. */
  deadlineMs: number | undefined;
  writtenPath: string;
  maxItems: number;
  /** Why the file was never opened for checking, when the source said why. */
  notPrimed?: string | undefined;
}): string {
  const { beforeSeen, beforeProblems, afterProblems, writtenPath, maxItems } = context;
  const display = displayPath(writtenPath);
  if (!beforeSeen) {
    // Nothing reported on this file before the write, so there is nothing to
    // diff and nothing may be called new: a problem that shows up now may have
    // been sitting in the file for months. This module used to run the same
    // diff against an empty before list and call every problem a new one, which
    // sent the model hunting for a break its edit never introduced.
    const reportable = afterProblems.filter((problem) => problem.severity <= REPORTABLE_SEVERITY);
    if (reportable.length > 0) return problemsNote(display, reportable, maxItems);
    // An event naming this file is the service saying "I looked, and there is
    // nothing to say"; no event is the service never having looked at all.
    return context.eventArrived
      ? `No problems reported in ${display} after this edit.`
      : notReportedNote(context.aborted, context.deadlineMs, context.notPrimed);
  }
  const introduced = diffProblems(beforeProblems, afterProblems).filter(
    (problem) => problem.severity <= REPORTABLE_SEVERITY,
  );
  const shown = introduced.slice(0, maxItems);
  if (shown.length === 0) {
    const gone = Math.max(
      0,
      beforeProblems.filter((problem) => problem.severity <= REPORTABLE_SEVERITY).length -
        afterProblems.filter((problem) => problem.severity <= REPORTABLE_SEVERITY).length,
    );
    // Two identical reads are not a check. An agent's edit goes to disk and the
    // editor's file watcher has to carry it to the language service, which can
    // lag — on a network drive it often lags past the deadline. Then the "after"
    // read is the picture the service already had BEFORE the write, and calling
    // that "No new problems" reports a verification that never happened. The
    // note says what is actually known instead, and where to go ask for it.
    // A picture that DID move is evidence of a re-check even with no event, so
    // that case still gets the diff it earned.
    if (beforeSeen && !context.eventArrived && sameProblems(beforeProblems, afterProblems)) {
      return notCheckedNote(writtenPath, context.aborted, context.deadlineMs);
    }
    return gone > 0
      ? `No new problems after this edit; ${gone} problem${gone === 1 ? '' : 's'} this file ` +
          `had before ${gone === 1 ? 'is' : 'are'} gone.`
      : 'No new problems after this edit.';
  }
  const sources = [...new Set(shown.map((problem) => problem.source ?? 'language service'))];
  const hidden = introduced.length - shown.length;
  return (
    `New problems after this edit (${sources.join(', ')}):\n` +
    shown.map((problem) => formatDiagnosticLine(display, problem)).join('\n') +
    (hidden > 0 ? `\n(+${hidden} more not shown; ask for the file's diagnostics to see them.)` : '')
  );
}

/**
 * The two reads are the same picture, so the diff between them proves nothing.
 *
 * Compared by problem identity and line, not by array order: a service that
 * re-reports the same problems in a different order has not learned anything
 * new about this edit either.
 */
function sameProblems(
  before: readonly ReportedProblem[],
  after: readonly ReportedProblem[],
): boolean {
  if (before.length !== after.length) return false;
  const canon = (list: readonly ReportedProblem[]): string[] =>
    list
      .map(
        (problem) =>
          `${problem.line}|${problem.source ?? ''}|${problem.code ?? ''}|` +
          `${problem.severity}|${problem.message}`,
      )
      .sort();
  return canon(before).join('\n') === canon(after).join('\n');
}

/**
 * Problems a file shows now, when nothing reported on it before the write.
 *
 * Worded differently from the "new problems" header on purpose: with no before
 * picture these are only "what the file shows now", and calling them this
 * edit's work would send the model to fix something it did not break.
 */
function problemsNote(
  display: string,
  reportable: readonly ReportedProblem[],
  maxItems: number,
): string {
  const shown = reportable.slice(0, maxItems);
  const sources = [...new Set(shown.map((problem) => problem.source ?? 'language service'))];
  const hidden = reportable.length - shown.length;
  return (
    `Problems in ${display} after this edit (${sources.join(', ')}; it had not been checked ` +
    `before, so some may predate it):\n` +
    shown.map((problem) => formatDiagnosticLine(display, problem)).join('\n') +
    (hidden > 0 ? `\n(+${hidden} more not shown; ask for the file's diagnostics to see them.)` : '')
  );
}

/**
 * Which problems the write introduced.
 *
 * Keyed by source, code, severity and message — the identity of a problem — and
 * matched positionally by line order within that key, so an error that only
 * MOVED because the edit added lines above it is not counted as a new one. The
 * plan's "line after shifting" is exactly this: counting by identity first and
 * by line second is the only way a moved problem and a new problem differ.
 */
export function diffProblems(
  before: readonly ReportedProblem[],
  after: readonly ReportedProblem[],
): ReportedProblem[] {
  const byIdentity = new Map<string, { before: ReportedProblem[]; after: ReportedProblem[] }>();
  const add = (problem: ReportedProblem, side: 'before' | 'after'): void => {
    const key = `${problem.source ?? ''}|${problem.code ?? ''}|${problem.severity}|${problem.message}`;
    const group = byIdentity.get(key) ?? { before: [], after: [] };
    (side === 'before' ? group.before : group.after).push(problem);
    byIdentity.set(key, group);
  };
  for (const problem of before) add(problem, 'before');
  for (const problem of after) add(problem, 'after');
  const introduced: ReportedProblem[] = [];
  for (const group of byIdentity.values()) {
    const beforeLines = group.before.map((problem) => problem.line).sort((a, b) => a - b);
    const afterSorted = [...group.after].sort((a, b) => a.line - b.line);
    // More copies of this identity than there were, or copies at lines that
    // were not in the before list once the earlier ones are paired off.
    for (let index = beforeLines.length; index < afterSorted.length; index += 1) {
      introduced.push(afterSorted[index]!);
    }
  }
  return introduced.sort((a, b) => a.line - b.line);
}
