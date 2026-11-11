import * as vscode from 'vscode';
import * as path from 'path';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { resolveRipgrep } from './RipgrepResolver';
import { formatPathMiss } from './pathMissText';
import { gitCwd, repoRelative, resolveFilePath } from './gitRepo';

const execFileAsync = promisify(execFile);

function isMissingPathError(err: unknown): boolean {
  return (
    (err as NodeJS.ErrnoException)?.code === 'ENOENT' ||
    (err instanceof Error && /\bnonexistent file\b/u.test(err.message))
  );
}

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
  return formatPathMiss(
    tool,
    requestedPath,
    err,
    workspaceRoot,
    tool === 'read_file' && isMissingPathError(err)
      ? uniqueSameNamePath(requestedPath, workspaceRoot)
      : undefined,
  );
}

/** Add a Git hint only when another ref contains a commit with the missing path. */
export async function describeReadFilePathMiss(
  requestedPath: string,
  err: unknown,
): Promise<string> {
  const message = describePathMiss('read_file', requestedPath, err);
  if (!isMissingPathError(err)) return message;
  try {
    const repoRoot = await gitCwd(requestedPath);
    const repoPath = repoRelative({ root: repoRoot }, resolveFilePath(requestedPath)).replace(
      /\\/gu,
      '/',
    );
    if (!repoPath || repoPath === '..' || repoPath.startsWith('../') || path.isAbsolute(repoPath))
      return message;
    const [history, branchResult] = await Promise.all([
      execFileAsync('git', ['log', '--all', '-1', '--format=%h%x09%D', '--', repoPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      }),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      }),
    ]);
    const tab = history.stdout.indexOf('\t');
    const shortSha = tab < 0 ? '' : history.stdout.slice(0, tab).trim();
    if (!shortSha) return message;
    const branch = branchResult.stdout.trim() || 'HEAD';
    const refsResult = await execFileAsync(
      'git',
      ['for-each-ref', '--contains', shortSha, '--format=%(refname:short)'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 3_000, windowsHide: true },
    );
    const refs = refsResult.stdout
      .split(/\r?\n/u)
      .map((ref) => ref.trim())
      .filter(Boolean);
    const isCurrentBranch = (ref: string): boolean => ref === branch;
    if (!refs.some((ref) => !isCurrentBranch(ref))) return message;
    const decorations = history.stdout.slice(tab + 1).trim();
    const directRef = decorations
      .split(',')
      .map((ref) => ref.trim().replace(/^HEAD -> /u, ''))
      .find(
        (ref) => ref && !ref.startsWith('tag: ') && refs.includes(ref) && !isCurrentBranch(ref),
      );
    const onRef = directRef ? ' on ' + directRef : '';
    return (
      message +
      ' It is not on the current branch (' +
      branch +
      '), but commit ' +
      shortSha +
      onRef +
      ' has it: use git_read show to read it there, or switch_branch.'
    );
  } catch {
    // Git discovery/history is optional advice; preserve the existing file-miss answer.
    return message;
  }
}
