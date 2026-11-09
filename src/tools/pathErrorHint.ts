import * as path from 'path';
import * as vscode from 'vscode';

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
export function describePathMiss(tool: string, requestedPath: string, err: unknown): string {
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
      `${message} Use find_files to locate it before retrying.`
    );
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Show the request and the resolution separately: seeing only one of them is
  // what makes a wrong base indistinguishable from a wrong filename.
  const base = root
    ? `"${requestedPath}" resolved against the workspace root ${root}.`
    : `"${requestedPath}" resolved with no workspace folder open.`;
  return (
    `${tool}: nothing exists there. ${base} ${message} ` +
    'The workspace root is often not the project root, so a path that looks right ' +
    'for the project can still miss. Use find_files to locate it before retrying.'
  );
}
