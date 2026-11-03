import * as fs from 'fs';
import * as vscode from 'vscode';
import { globToRegExp, normalizePathForMatch } from './secretPaths';

/**
 * `tools.file_length_warning`, and the ONE place a write result gains the
 * file-length line.
 *
 * Why here rather than in each tool: the text, the line count and the glob
 * match are one decision, and four tools make it. Written into each handler it
 * would drift the moment one of them reworded its own result, and the
 * acceptance test for this feature is exactly "the same line, from the same
 * point, for every tool that writes a file's contents". Each tool calls this
 * once, on its success path, with the path it just wrote.
 *
 * Why the tool and not `ToolDispatch`: dispatching is shared by every tool,
 * including `delete_file`, `move_file` and `format_file`,
 * which do not write content the agent authored — a warning on those is noise
 * the agent did not ask for. Naming the content writers inside the dispatcher
 * would only move the per-tool list from the tools to the dispatcher.
 *
 * The warning is advisory: it never fails a write that succeeded, and a file
 * this cannot read simply gets no line.
 */

/** `tools.file_length_warning` as config.yaml states it. Absent means off. */
export interface FileLengthWarningSettings {
  warn_at: number;
  max: number;
  globs?: readonly string[];
}

/** Read live, so editing config.yaml changes the threshold without re-registering the tools. */
export type FileLengthWarningGetter = () => FileLengthWarningSettings | undefined;

/** Lines as `wc -l` counts them: the number of line breaks in the file. A file
 *  whose last line has no break reports one fewer than a text editor shows —
 *  the same conservative direction `wc -l` itself has, and the reason CLAUDE.md
 *  says to measure with `wc -l` and never with `split('\n').length`. */
export function countLinesAsWcL(content: string): number {
  let lines = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') lines += 1;
  }
  return lines;
}

/**
 * The warning line for a file just written, or '' when there is nothing to say:
 * no `tools.file_length_warning` block, the file matches no configured glob, or
 * the write left it below `warn_at`.
 */
export function fileLengthWarning(
  writtenPath: string,
  settings: FileLengthWarningSettings | undefined,
): string {
  if (!settings) return '';
  const globs = settings.globs;
  if (globs !== undefined && globs.length === 0) return '';
  if (globs !== undefined && !matchesAnyGlob(writtenPath, globs)) return '';
  let content: string;
  try {
    content = fs.readFileSync(writtenPath, 'utf8');
  } catch {
    // Advisory only: a file we cannot re-read (deleted by another process, a
    // permissions change) must not turn a completed write into a failure.
    return '';
  }
  const lines = countLinesAsWcL(content);
  if (lines > settings.max) {
    return (
      `This file is now ${lines} lines, over the limit ${settings.max} ` +
      '(from tools.file_length_warning); split it at a real seam before continuing.'
    );
  }
  if (lines >= settings.warn_at) {
    return (
      `This file is now ${lines} lines (limit ${settings.max}, from ` +
      'tools.file_length_warning). Plan where to split it before adding more.'
    );
  }
  return '';
}

/** The one append point: `result` plus the warning line, or `result` untouched. */
export function withFileLengthWarning(
  result: string,
  writtenPath: string,
  settings: FileLengthWarningSettings | undefined,
): string {
  const warning = fileLengthWarning(writtenPath, settings);
  return warning ? `${result}\n${warning}` : result;
}

/**
 * Whether this written file matches the configured globs.
 *
 * Matched against BOTH the absolute path and the path relative to the open
 * workspace: a glob naming a folder below the root (`src/`, then `**`, then
 * `*.ts`) is written workspace-relative and cannot match an absolute path, while
 * a `**`-prefixed glob matches either way. A pattern that means nothing one way
 * is not a reason to miss the file it was written for. The glob is spelled in
 * pieces here because `**` then `/` then `*` closes a block comment.
 */
function matchesAnyGlob(writtenPath: string, globs: readonly string[]): boolean {
  const candidates = [writtenPath, relativeToWorkspace(writtenPath)]
    .map((candidate) => normalizePathForMatch(candidate))
    .filter((candidate) => candidate.length > 0);
  for (const glob of globs) {
    const regex = globToRegExp(normalizePathForMatch(glob));
    if (candidates.some((candidate) => regex.test(candidate))) return true;
  }
  return false;
}

/** Workspace-relative spelling, or '' when there is no open workspace. */
function relativeToWorkspace(writtenPath: string): string {
  try {
    const relative = vscode.workspace.asRelativePath(vscode.Uri.file(writtenPath), false);
    return relative === writtenPath ? '' : relative;
  } catch {
    // The tool host may have no workspace, or a stub `asRelativePath`; the
    // absolute spelling above already answers this call.
    return '';
  }
}
