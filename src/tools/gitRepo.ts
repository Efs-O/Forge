/**
 * Access to VS Code's built-in Git extension, shared by the read-only and
 * mutating git tools.
 *
 * Split out of `gitTools.ts`: both halves need the same repository handle and
 * the same path/status conversions, and neither should own it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

// ── Git API bootstrap ─────────────────────────────────────────────────────────
export interface GitRepository {
  /** Repository root, as discovered by VS Code's Git extension. */
  rootUri?: vscode.Uri;
  state: {
    workingTreeChanges: Array<{ uri: vscode.Uri; status: number }>;
    indexChanges: Array<{ uri: vscode.Uri; status: number }>;
  };
  log(opts: {
    maxEntries: number;
    ref?: string;
  }): Promise<Array<{ hash: string; message: string; authorName: string; commitDate: Date }>>;
  diff(staged: boolean): Promise<string>;
  show(ref: string): Promise<string>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  checkout(branch: string): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
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

function repositories(): GitRepository[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vscode.git API is untyped
  const gitExt = vscode.extensions.getExtension<any>('vscode.git');
  const git = gitExt?.exports?.getAPI(1);
  const repos = git?.repositories as GitRepository[] | undefined;
  if (!repos?.length) throw new Error('git_*: no git repository found in workspace');
  return repos;
}

/**
 * Resolve a VS Code Git repository for a workspace-relative directory or file.
 *
 * The Git extension discovers every repository in a workspace. Selecting its
 * first entry is unsafe when the workspace root and a nested project are both
 * repositories: status may describe one repository while stage/commit mutate
 * another. When a location is supplied, choose the deepest containing root.
 */
export function getRepo(location?: string): GitRepository {
  const repos = repositories();
  if (location === undefined) {
    if (repos.length === 1) return repos[0];
    throw new Error(
      `git_*: multiple repositories found; pass cwd (${repoRoots(repos).join(', ')})`,
    );
  }

  return getRepoFrom(repos, location);
}

function getRepoFrom(repos: readonly GitRepository[], location: string): GitRepository {
  const resolved = resolveFilePath(location);
  const matching = repos
    .filter((repo) => repo.rootUri && containsPath(repo.rootUri.fsPath, resolved))
    .sort((a, b) => (b.rootUri?.fsPath.length ?? 0) - (a.rootUri?.fsPath.length ?? 0));
  if (matching.length) return matching[0];

  throw new Error(
    `git_*: no repository contains "${location}"; detected repositories: ${repoRoots(repos).join(', ')}`,
  );
}

/** Select one repository for a stage request and reject cross-repository calls. */
export function getRepoForPaths(paths: readonly string[]): GitRepository {
  if (!paths.length) throw new Error('git_stage: at least one path is required');
  // Take one Git API snapshot for the whole batch. The built-in extension may
  // return fresh repository wrapper objects from separate getAPI() calls, so
  // object identity is not a stable repository key.
  const repos = repositories();
  const selected = paths.map((filePath) => getRepoFrom(repos, filePath));
  const first = selected[0];
  const firstRoot = canonicalPath(first.rootUri?.fsPath ?? '');
  if (
    !firstRoot ||
    selected.some((repo) => canonicalPath(repo.rootUri?.fsPath ?? '') !== firstRoot)
  ) {
    throw new Error(
      'git_stage: paths belong to different repositories; stage each repository separately',
    );
  }
  return first;
}

export async function withGitError<T>(
  operation: string,
  repo: GitRepository,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const root = repo.rootUri?.fsPath ?? '(repository root unavailable)';
    throw new Error(`${operation} failed in repository "${root}": ${detail}`);
  }
}

/**
 * Run Git directly for mutations and index-sensitive reads. The VS Code Git
 * API remains useful for finding the selected repository, but its UI state is
 * not the source of truth for a tool result that promises to have changed the
 * real index.
 */
export async function runGit(repo: GitRepository, args: readonly string[]): Promise<string> {
  const root = repo.rootUri?.fsPath;
  if (!root) throw new Error('git: selected repository has no root path');
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
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
    const detail = output || error.message || String(err);
    throw new Error(`git ${args[0] ?? 'command'} failed in repository "${root}": ${detail}`);
  }
}

/** Read the actual index and working tree using Git's stable porcelain format. */
export async function readLiveGitStatus(repo: GitRepository): Promise<LiveGitStatusEntry[]> {
  const output = await runGit(repo, ['status', '--porcelain=v1', '-z']);
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

function containsPath(root: string, target: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(target));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function canonicalPath(value: string): string {
  if (!value) return '';
  // Do not realpath only the existing side: on Windows that can turn the repo
  // root into an 8.3 short path while a new file keeps its long spelling.
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function repoRoots(repos: readonly GitRepository[]): string[] {
  return repos.map((repo) => repo.rootUri?.fsPath ?? '(repository root unavailable)');
}

export function workspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) throw new Error('No workspace folder open');
  return folders[0].uri.fsPath;
}

export function resolveFilePath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.join(workspaceRoot(), p);
}

/**
 * Directory to spawn `git` in.
 *
 * The tools that go through VS Code's Git API (`git_status`, `git_log`,
 * plain `git_diff`) work in a workspace whose repository sits in a
 * subdirectory, because the API discovers repositories rather than assuming
 * one at the root. The tools that spawn git directly passed `workspaceRoot()`
 * and got `fatal: not a git repository` for the same workspace — measured on
 * `git_blame` and `git_show` against a repo one directory down.
 *
 * Prefers the repository containing `filePath`, so a workspace holding several
 * repositories blames the right one; falls back to the discovered repository,
 * then to the workspace root.
 */
export function gitCwd(filePath?: string): string {
  if (filePath) {
    const resolved = resolveFilePath(filePath);
    const from =
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
    const fromFile = findRepoRoot(from);
    if (fromFile) return fromFile;
  }
  try {
    const root = getRepo().rootUri?.fsPath;
    if (root) return root;
  } catch {
    // No repository discovered — fall through to the workspace root, where git
    // will produce its own, clearer "not a git repository" message.
  }
  return workspaceRoot();
}

/** Nearest ancestor of `from` containing a `.git` entry, or undefined. */
function findRepoRoot(from: string): string | undefined {
  let current = from;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
