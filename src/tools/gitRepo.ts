/**
 * The repository handle shared by the read-only and mutating git tools, plus
 * the single place git is executed.
 *
 * Split out of `gitTools.ts`: both halves need the same repository handle and
 * the same path/status conversions, and neither should own it. Discovery — the
 * question of *which* repository — lives in `gitDiscovery.ts`.
 *
 * Every tool now executes through `runGit`. The VS Code Git extension remains a
 * discovery aid, but its wrapper methods are no longer an execution path: a
 * tool that promises to have moved HEAD or written the index must be reporting
 * on the real repository, and having two execution paths meant two sets of
 * error shapes, two behaviours when the extension is absent, and two places to
 * audit before trusting a result.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  canonicalPath,
  containsPath,
  realPathLike,
  repoRootForLocation,
  repoRootForWorkspace,
  resolveFilePath,
  workspaceRoot,
} from './gitDiscovery';
import { gitIdentityHint } from './commandHints';

const execFileAsync = promisify(execFile);

export { resolveFilePath };

/** Resolve a Git path with the shared cwd/workspace spelling rules. */
export function resolveGitPath(filePath: string, cwd?: string): string {
  if (cwd === undefined || path.isAbsolute(filePath)) return resolveFilePath(filePath);
  const resolvedCwd = resolveFilePath(cwd);
  const cwdDirectory =
    fs.existsSync(resolvedCwd) && fs.statSync(resolvedCwd).isFile()
      ? path.dirname(resolvedCwd)
      : resolvedCwd;
  const workspacePath = resolveFilePath(filePath);
  return containsPath(cwdDirectory, workspacePath)
    ? workspacePath
    : path.resolve(cwdDirectory, filePath);
}

/** Select a repository and resolve any supplied file paths using one policy. */
export async function resolveGitRequest(
  tool: string,
  cwd?: string,
  requestedPaths: readonly string[] = [],
): Promise<{ repo: GitRepoHandle; paths: string[] }> {
  let resolvedCwd: string | undefined;
  let repo: GitRepoHandle;
  if (cwd !== undefined) {
    resolvedCwd = resolveFilePath(cwd);
    if (!fs.existsSync(resolvedCwd)) {
      throw new Error(
        `${tool}: cwd "${cwd}" does not exist (resolved to ${resolvedCwd}). ` +
          `A relative cwd resolves from the workspace root, ${workspaceRoot()}. ` +
          "Pass the repository's directory, absolute or relative to that root.",
      );
    }
    try {
      repo = await getRepo(resolvedCwd);
    } catch (cwdError) {
      if (!requestedPaths.length) throw cwdError;
      const cwdDirectory = fs.statSync(resolvedCwd).isFile()
        ? path.dirname(resolvedCwd)
        : resolvedCwd;
      await getRepoForPaths(requestedPaths, { base: cwdDirectory, cwd: resolvedCwd });
      throw cwdError;
    }
  } else if (requestedPaths.length) {
    repo = await getRepoForPaths(requestedPaths);
  } else {
    repo = await getRepo();
  }

  const paths = requestedPaths.map((requestedPath) => resolveGitPath(requestedPath, cwd));
  if (resolvedCwd !== undefined) {
    for (let index = 0; index < paths.length; index++) {
      const absolute = paths[index]!;
      const pathRepo = containsPath(repo.root, absolute) ? await getRepo(absolute) : undefined;
      if (pathRepo === undefined || canonicalPath(pathRepo.root) !== canonicalPath(repo.root)) {
        const requestedPath = requestedPaths[index]!;
        throw new Error(
          `${tool}: path "${requestedPath}" resolves to ${absolute}, which is outside the repository that cwd "${cwd}" selects (${repo.root}). ` +
            'Pass a path inside that repository, relative to cwd or to the workspace root.',
        );
      }
    }
  }
  return { repo, paths };
}

/**
 * A selected repository.
 *
 * Narrowed to what the tools actually consume. It previously mirrored the Git
 * extension's repository interface — `log`, `diff`, `show`, `add`, `commit`,
 * `state` — of which only `rootUri` was still read once the mutating tools had
 * moved to the CLI. Keeping the unused methods would have forced every
 * CLI-discovered root to be cast into a shape it cannot honour.
 */
export interface GitRepoHandle {
  /** Absolute repository root (the worktree top level). */
  root: string;
}

export interface LiveGitStatusEntry {
  /** Index column from porcelain v1's XY record. */
  index: string;
  /** Working-tree column from porcelain v1's XY record. */
  workingTree: string;
  path: string;
  /** Present for rename/copy records. */
  originalPath?: string;
}

/**
 * Resolve the repository for an optional workspace-relative directory or file.
 *
 * With a location, git's own `rev-parse --show-toplevel` decides, so a nested
 * repository is never captured by an outer one. Without a location, the choice
 * must be unambiguous — see `repoRootForWorkspace`.
 */
export async function getRepo(
  location?: string,
  options: { base?: string; cwd?: string } = {},
): Promise<GitRepoHandle> {
  const root =
    location === undefined
      ? await repoRootForWorkspace()
      : await repoRootForLocation(location, options);
  return { root };
}

/** Select one repository for a stage request and reject cross-repository calls. */
export async function getRepoForPaths(
  paths: readonly string[],
  options: { base?: string; cwd?: string } = {},
): Promise<GitRepoHandle> {
  if (!paths.length) throw new Error('git_stage: at least one path is required');
  // Resolve every path against the same discovery rules; a batch spanning two
  // repositories must fail rather than stage half of itself.
  const roots = await Promise.all(paths.map((filePath) => repoRootForLocation(filePath, options)));
  const first = roots[0];
  if (roots.some((root) => canonicalPath(root) !== canonicalPath(first))) {
    throw new Error(
      'git_stage: paths belong to different repositories; stage each repository separately',
    );
  }
  return { root: first };
}

export async function withGitError<T>(
  operation: string,
  repo: GitRepoHandle,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${operation} failed in repository "${repo.root}": ${detail}`);
  }
}

/**
 * Run git in the selected repository.
 *
 * Arguments are passed as an array — never a command string — so a branch name
 * or commit message cannot become shell syntax. Output is bounded so a
 * pathological `git log` cannot fill the model's context by itself.
 */
export async function runGit(repo: GitRepoHandle, args: readonly string[]): Promise<string> {
  if (!repo.root) throw new Error('git: selected repository has no root path');
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd: repo.root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const output = [error.stderr, error.stdout]
      .filter(
        (value): value is string | Buffer => value !== undefined && String(value).trim() !== '',
      )
      .map((value) => String(value).trim())
      .join('\n');
    const detail =
      error.code === 'ENOENT' && !output
        ? 'the git executable was not found on PATH. Install Git and make it available on PATH.'
        : output || error.message || String(err);
    throw new Error(
      `git ${args[0] ?? 'command'} failed in repository "${repo.root}": ${detail}${gitIdentityHint(detail)}`,
    );
  }
}

/** Read the actual index and working tree using Git's stable porcelain format.
 *  `paths` (repository-relative) limits the read to those pathspecs. */
export async function readLiveGitStatus(
  repo: GitRepoHandle,
  paths: readonly string[] = [],
): Promise<LiveGitStatusEntry[]> {
  const output = await runGit(repo, [
    'status',
    '--porcelain=v1',
    '-z',
    ...(paths.length ? ['--', ...paths] : []),
  ]);
  const records = output.split('\0');
  const entries: LiveGitStatusEntry[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const x = record[0] ?? ' ';
    const y = record[1] ?? ' ';
    if (record[2] !== ' ') continue;
    const entry: LiveGitStatusEntry = { index: x, workingTree: y, path: record.slice(3) };
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const originalPath = records[++index];
      if (originalPath) entry.originalPath = originalPath;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Directory to spawn git in for the tools that still shell out themselves
 * (the `git_read` blame, per-file diff, and show operations).
 *
 * Prefers the repository containing `filePath`, so a workspace holding several
 * repositories blames the right one. It no longer swallows an ambiguity error
 * and picks an arbitrary workspace root: a caller that cannot tell which
 * repository it is talking about must say so, not guess.
 */
export async function gitCwd(filePath?: string): Promise<string> {
  const repo = await getRepo(filePath);
  return repo.root;
}

/**
 * Repository-relative form of an absolute or workspace-relative path.
 *
 * Both sides go through `realPathLike` so a root spelled by git and a path
 * spelled by VS Code compare as the same directory — otherwise the result walks
 * out of the repository and git rejects the pathspec as "outside repository".
 */
export function repoRelative(repo: GitRepoHandle, filePath: string): string {
  return path.relative(realPathLike(repo.root), realPathLike(resolveFilePath(filePath)));
}
