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
