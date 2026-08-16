/**
 * Access to VS Code's built-in Git extension, shared by the read-only and
 * mutating git tools.
 *
 * Split out of `gitTools.ts`: both halves need the same repository handle and
 * the same path/status conversions, and neither should own it.
 */

import * as path from 'path';
import * as vscode from 'vscode';

// ── Git API bootstrap ─────────────────────────────────────────────────────────
export interface GitRepository {
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

export function getRepo(): GitRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vscode.git API is untyped
  const gitExt = vscode.extensions.getExtension<any>('vscode.git');
  const git = gitExt?.exports?.getAPI(1);
  const repo: GitRepository | undefined = git?.repositories?.[0];
  if (!repo) throw new Error('git_*: no git repository found in workspace');
  return repo;
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
