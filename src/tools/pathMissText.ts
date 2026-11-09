import * as path from 'path';

/**
 * Turns a filesystem error into one the model can act on.
 *
 * A bare `ENOENT: no such file or directory, open 'n:\\a\\b\\c.ts'` cannot tell
 * the model whether it guessed the *filename* wrong or the *base* wrong — and
 * the base is the usual culprit here, because the workspace root is routinely
 * not the project root (see CLAUDE.md). Naming the root the path resolved
 * against, and the tool that finds files, turns a dead round into a recoverable
 * one.
 *
 * A miss, in either of its two vocabularies. `EISDIR`, `EACCES` and friends already say
 * what is wrong, and inventing advice for them would be guessing.
 */
export function formatPathMiss(
  tool: string,
  requestedPath: string,
  err: unknown,
  workspaceRoot: string | undefined,
  sameNamePath?: string,
): string {
  const message = err instanceof Error ? err.message : String(err);
  if (tool === 'read_file' && /\bEISDIR\b/u.test(message)) {
    return `${tool}: "${requestedPath}" is a directory, not a file. Use list_directory to see what is in it, or find_files to search it.`;
  }
  // Two vocabularies mean the same miss: Node's `ENOENT`, and VS Code's
  // `Unable to resolve nonexistent file`, which is what `openNotebookDocument` throws
  // (lab arm U5a, 2026-11-09). A tool that goes through VS Code's file API gets the same
  // actionable answer as one that calls `fs` itself.
  if (!/\b(?:ENOENT|nonexistent file)\b/u.test(message)) return `${tool}: ${message}`;
  if (path.isAbsolute(requestedPath)) {
    // An absolute path is used as given; naming the workspace root here sent
    // the model to the wrong base (U16-08).
    return (
      `${tool}: nothing exists there. "${requestedPath}" is absolute, so it was used as given. ` +
      `${message} ${sameNameHint(tool, sameNamePath)}Use find_files to locate it before retrying.`
    );
  }
  // Show the request and the resolution separately: seeing only one of them is
  // what makes a wrong base indistinguishable from a wrong filename.
  const base = workspaceRoot
    ? `"${requestedPath}" resolved against the workspace root ${workspaceRoot}.`
    : `"${requestedPath}" resolved with no workspace folder open.`;
  return (
    `${tool}: nothing exists there. ${base} ${message} ` +
    sameNameHint(tool, sameNamePath) +
    'The workspace root is often not the project root, so a path that looks right ' +
    'for the project can still miss. Use find_files to locate it before retrying.'
  );
}

function sameNameHint(tool: string, match: string | undefined): string {
  return tool === 'read_file' && match ? `Did you mean "${match}"? ` : '';
}
