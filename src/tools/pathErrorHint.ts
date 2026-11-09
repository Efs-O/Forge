import * as vscode from 'vscode';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { resolveRipgrep } from './RipgrepResolver';
import { formatPathMiss } from './pathMissText';

/** Find a same-basename workspace file with the project's ripgrep engine. */
function uniqueSameNamePath(
  requestedPath: string,
  workspaceRoot: string | undefined,
): string | undefined {
  if (!workspaceRoot) return undefined;
  const requestedName = path.basename(requestedPath.replace(/\\/gu, '/'));
  if (!requestedName) return undefined;
  const rg = resolveRipgrep(vscode.env.appRoot);
  const result = spawnSync(
    rg.command,
    [...(rg.argsPrefix ?? []), '--files', '--hidden', '--glob', `**/${requestedName}`],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 3_000,
      windowsHide: true,
    },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) return undefined;
  const matches = result.stdout
    .split(/\r?\n/u)
    .map((match) => match.trim().replace(/\\/gu, '/').replace(/^\.\//u, ''))
    .filter(
      (match) =>
        match &&
        (process.platform === 'win32'
          ? path.posix.basename(match).toLowerCase() === requestedName.toLowerCase()
          : path.posix.basename(match) === requestedName),
    );
  return matches.length === 1 ? matches[0] : undefined;
}

export function describePathMiss(tool: string, requestedPath: string, err: unknown): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const isMissing =
    (err as NodeJS.ErrnoException)?.code === 'ENOENT' ||
    (err instanceof Error && /\bnonexistent file\b/u.test(err.message));
  return formatPathMiss(
    tool,
    requestedPath,
    err,
    workspaceRoot,
    tool === 'read_file' && isMissing
      ? uniqueSameNamePath(requestedPath, workspaceRoot)
      : undefined,
  );
}
