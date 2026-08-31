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
 * ENOENT only. `EISDIR`, `EACCES` and friends already say what is wrong, and
 * inventing advice for them would be guessing.
 */
export function describePathMiss(tool: string, requestedPath: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!/\bENOENT\b/u.test(message)) return `${tool}: ${message}`;
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
