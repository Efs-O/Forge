/**
 * Repository discovery for the git tools.
 *
 * Split out of `gitRepo.ts`, which now owns only the repository handle, git
 * execution and status parsing. Discovery grew its own concerns — extension
 * activation, CLI probing, ambiguity rules and error classification — and they
 * are the half that has to answer "which repository is this?" before anything
 * runs.
 *
 * Two sources, in a fixed order of authority:
 *
 *   1. `git rev-parse --show-toplevel`, run in the directory in question. This
 *      is git's own answer, so it is right about nested repositories, worktrees
 *      whose `.git` is a file, and repositories VS Code has not indexed.
 *   2. VS Code's Git extension, used when the CLI is unavailable and as a
 *      source of candidate roots when no location was supplied.
 *
 * The CLI leads because the extension's repository list is *partial*: it holds
 * what VS Code happened to discover. Selecting the deepest API root that
 * contains a path silently captures work meant for a nested repository the
 * extension never opened.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { logger } from '../util/logger';

const execFileAsync = promisify(execFile);

/** Kinds of discovery failure the tools must be able to tell apart. */
export type GitDiscoveryFailure =
  | 'git-missing'
  | 'not-a-repository'
  | 'invalid-location'
  | 'permission'
  | 'trust'
  | 'ambiguous';

export class GitDiscoveryError extends Error {
  constructor(
    readonly kind: GitDiscoveryFailure,
    message: string,
  ) {
    super(message);
    this.name = 'GitDiscoveryError';
  }
}

// ── path identity ─────────────────────────────────────────────────────────────

/**
 * Resolve symlinks and Windows 8.3 short names as far as the path exists,
 * keeping the not-yet-created remainder verbatim.
 *
 * Both sides of every comparison go through this. Realpathing only the existing
 * side is what breaks: `git rev-parse --show-toplevel` prints the long spelling
 * (`C:\\Users\\efso office\\…`) while VS Code's workspace root can carry the
 * short one (`C:\\Users\\EFSOOF~1\\…`), and `path.relative` between the two then
 * walks out of the repository and produces a pathspec git rejects as "outside
 * repository". Leaving the missing tail alone is equally load-bearing: `stage`
 * is routinely called on a file the agent is about to create.
 */
export function realPathLike(value: string): string {
  let current = path.resolve(value);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Comparison key for a filesystem path. */
export function canonicalPath(value: string): string {
  if (!value) return '';
  const resolved = realPathLike(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

export function containsPath(root: string, target: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(target));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

// ── location resolution ───────────────────────────────────────────────────────

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

export function workspaceRoot(): string {
  const roots = workspaceRoots();
  if (!roots.length) throw new GitDiscoveryError('invalid-location', 'No workspace folder open');
  return roots[0];
}

export function resolveFilePath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.join(workspaceRoot(), p);
}

/**
 * Nearest existing directory at or above `location`.
 *
 * A caller may name a file that does not exist yet — `stage` on a path the
 * agent is about to create is the ordinary case — so walking up is not a
 * fallback, it is the normal path.
 */
function nearestExistingDirectory(location: string): string {
  let current = resolveFilePath(location);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      /* missing: walk up */
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new GitDiscoveryError(
        'invalid-location',
        `git_*: no existing directory at or above "${location}"`,
      );
    }
    current = parent;
  }
}

// ── CLI probing ───────────────────────────────────────────────────────────────

interface ProbeFailure {
  kind: GitDiscoveryFailure;
  detail: string;
}

let cliUnavailableReported = false;

/**
 * Ask git for the top-level directory of the repository containing `dir`.
 *
 * Returns the root, or a classified failure. A missing git binary and a
 * directory that simply is not a repository are different answers, and the
 * error the user eventually sees depends on which one it was.
 */
async function probeRepoRoot(dir: string): Promise<string | ProbeFailure> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
    const root = stdout.trim();
    if (!root) return { kind: 'not-a-repository', detail: `git reported no repository in ${dir}` };
    // On Windows git prints a forward-slash path; normalise so identity
    // comparisons against VS Code and Node paths line up.
    return path.resolve(root);
  } catch (err) {
    return classifyProbeError(err, dir);
  }
}

function classifyProbeError(err: unknown, dir: string): ProbeFailure {
  const error = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
  const stderr = String(error.stderr ?? '').trim();
  const message = stderr || error.message || String(err);

  if (error.code === 'ENOENT' && !stderr) {
    // execFile reports ENOENT both for a missing binary and a missing cwd.
    if (!fs.existsSync(dir)) {
      return { kind: 'invalid-location', detail: `directory does not exist: ${dir}` };
    }
    if (!cliUnavailableReported) {
      cliUnavailableReported = true;
      logger.warn(
        'git_*: the git executable was not found on PATH; falling back to the VS Code Git extension',
      );
    }
    return { kind: 'git-missing', detail: 'the git executable was not found on PATH' };
  }
  if (error.code === 'EACCES' || /permission denied/i.test(message)) {
    return { kind: 'permission', detail: message };
  }
  if (/dubious ownership|safe\.directory/i.test(message)) {
    return { kind: 'trust', detail: message };
  }
  if (/not a git repository|no such file or directory/i.test(message)) {
    return { kind: 'not-a-repository', detail: message };
  }
  return { kind: 'not-a-repository', detail: message };
}

function isProbeFailure(value: string | ProbeFailure): value is ProbeFailure {
  return typeof value !== 'string';
}

/** Turn a probe failure into the error the tool caller should see. */
function probeFailureError(location: string, failure: ProbeFailure): GitDiscoveryError {
  const where = `"${location}"`;
  switch (failure.kind) {
    case 'git-missing':
      return new GitDiscoveryError(
        'git-missing',
        `git_*: ${failure.detail}, and VS Code's Git extension reported no repository for ${where}. ` +
          'Install Git and make it available on PATH.',
      );
    case 'invalid-location':
      return new GitDiscoveryError('invalid-location', `git_*: ${failure.detail}`);
    case 'permission':
      return new GitDiscoveryError('permission', `git_*: cannot read ${where}: ${failure.detail}`);
    case 'trust':
      return new GitDiscoveryError(
        'trust',
        `git_*: git refused to use the repository at ${where}: ${failure.detail}. ` +
          'Forge does not change git trust settings; resolve this in git configuration.',
      );
    default:
      return new GitDiscoveryError(
        'not-a-repository',
        `git_*: no git repository contains ${where}: ${failure.detail}`,
      );
  }
}

// ── VS Code Git extension ─────────────────────────────────────────────────────

/**
 * Roots VS Code's Git extension currently knows about.
 *
 * Never throws: an extension that is absent, inactive or failing is a reason to
 * fall back to the CLI, not a reason to fail the tool call. The failure is
 * logged so it is visible in diagnostics rather than silently absorbed.
 */
async function apiRepoRoots(): Promise<string[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vscode.git API is untyped
    const extension = vscode.extensions.getExtension<any>('vscode.git');
    if (!extension) return [];
    // A workspace that opens without a repository leaves the Git extension
    // inactive; its API is unavailable until it is.
    if (extension.isActive === false && typeof extension.activate === 'function') {
      await extension.activate();
    }
    const api = extension.exports?.getAPI?.(1);
    const repositories = api?.repositories as Array<{ rootUri?: { fsPath?: string } }> | undefined;
    return (repositories ?? [])
      .map((repo) => repo.rootUri?.fsPath)
      .filter((root): root is string => typeof root === 'string' && root.length > 0)
      .map((root) => path.resolve(root));
  } catch (err) {
    logger.warn(
      `git_*: VS Code Git extension API unavailable (${err instanceof Error ? err.message : String(err)}); using the git CLI`,
    );
    return [];
  }
}

function deepestContaining(roots: readonly string[], target: string): string | undefined {
  return roots.filter((root) => containsPath(root, target)).sort((a, b) => b.length - a.length)[0];
}

function dedupe(roots: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const root of roots) {
    const key = canonicalPath(root);
    if (!seen.has(key)) seen.set(key, root);
  }
  return [...seen.values()];
}

// ── selection ─────────────────────────────────────────────────────────────────

/**
 * Repository root for an explicit directory or file path.
 *
 * The CLI answers first because it is the only source that is right about a
 * nested repository the Git extension has not opened. The extension is consulted
 * only when git itself could not run.
 */
export async function repoRootForLocation(location: string): Promise<string> {
  const directory = nearestExistingDirectory(location);
  const probed = await probeRepoRoot(directory);
  if (!isProbeFailure(probed)) return probed;

  if (probed.kind === 'git-missing') {
    const fromApi = deepestContaining(await apiRepoRoots(), resolveFilePath(location));
    if (fromApi) return fromApi;
  }
  throw probeFailureError(location, probed);
}

/**
 * Repository root when the caller named no location.
 *
 * Candidates are the workspace folder roots that are themselves repositories
 * plus whatever the Git extension has discovered — never a recursive scan of
 * the workspace. More than one distinct root is an ambiguity the caller has to
 * resolve, because status describing one repository while a commit lands in
 * another is the failure this rule exists to prevent.
 */
export async function repoRootForWorkspace(): Promise<string> {
  const roots = workspaceRoots();
  if (!roots.length) throw new GitDiscoveryError('invalid-location', 'No workspace folder open');

  const candidates: string[] = [];
  let lastFailure: ProbeFailure | undefined;
  for (const root of roots) {
    const probed = await probeRepoRoot(root);
    if (isProbeFailure(probed)) lastFailure = probed;
    else candidates.push(probed);
  }
  candidates.push(...(await apiRepoRoots()));

  const distinct = dedupe(candidates);
  if (distinct.length === 1) return distinct[0];
  if (distinct.length > 1) {
    throw new GitDiscoveryError(
      'ambiguous',
      `git_*: multiple repositories found; pass cwd (${distinct.join(', ')})`,
    );
  }

  if (lastFailure && lastFailure.kind !== 'not-a-repository') {
    throw probeFailureError(roots[0], lastFailure);
  }
  throw new GitDiscoveryError(
    'not-a-repository',
    `git_*: no git repository at the workspace root (${roots.join(', ')}). ` +
      'If the repository is in a subdirectory, pass cwd naming it.',
  );
}
