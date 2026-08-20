/**
 * Access to VS Code's built-in Git extension, shared by the read-only and
 * mutating git tools.
 *
 * Split out of `gitTools.ts`: both halves need the same repository handle and
 * the same path/status conversions, and neither should own it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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
  const selected = paths.map((filePath) => getRepo(filePath));
  const first = selected[0];
  if (selected.some((repo) => repo !== first)) {
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

function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
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

// Status code → letter (subset of git status codes used by vscode.git)
export function statusLetter(s: number): string {
  if (s === 1) return 'M'; // Modified
  if (s === 2) return 'A'; // Added
  if (s === 3) return 'D'; // Deleted
  if (s === 4) return 'R'; // Renamed
  if (s === 5) return 'C'; // Copied
  if (s === 6) return 'U'; // Unmerged
  return '?';
}

// ── git_status ─────────────────────────────────────────────────────────────────
