import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { isPathInside } from './pathContainment';

// Re-exported so the many callers that reach for containment via this module
// keep working; the implementation lives in the vscode-free leaf module.
export { isPathInside };

export interface ResolveWorkspacePathOptions {
  workspaceRoot?: string;
  allowAbsolute?: boolean;
  mustBeInsideWorkspace?: boolean;
  /**
   * Absolute folders outside the workspace that also satisfy
   * `mustBeInsideWorkspace` — config.yaml `extra_file_roots`. Tasks such as a
   * llama.cpp install live in `%LOCALAPPDATA%\Forge`, which no workspace
   * contains; without a sanctioned root the agent improvised `robocopy` to
   * make a folder and left 550 MB of zips it could not delete.
   */
  extraRoots?: readonly string[];
}

function defaultWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function resolveWorkspacePath(
  filePath: string,
  options: ResolveWorkspacePathOptions = {},
): string {
  const root = options.workspaceRoot ?? defaultWorkspaceRoot();
  if (path.isAbsolute(filePath) && options.allowAbsolute === false) {
    throw new Error(`Absolute paths are not allowed: ${filePath}`);
  }
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : root
      ? path.resolve(root, filePath)
      : (() => {
          throw new Error('No workspace folder open; use an explicit absolute path.');
        })();
  const mustBeInsideWorkspace = options.mustBeInsideWorkspace ?? false;
  if (mustBeInsideWorkspace) {
    const extra = options.extraRoots ?? [];
    const inExtra = extra.some((r) => isPathInside(path.normalize(r), resolved));
    if (!inExtra) {
      if (!root) throw new Error('No workspace folder open');
      if (!isPathInside(root, resolved))
        // The audited agent retried one refused folder a dozen times with other
        // spellings and file names, a round each: say the refusal is the folder's.
        throw new Error(
          `Path is outside the workspace: ${filePath}` +
            (extra.length > 0
              ? ` (and outside extra_file_roots: ${extra.join(', ')})`
              : ' (add its folder to extra_file_roots in config.yaml to allow it)') +
            `. Every path under ${path.dirname(resolved)} is refused the same way, whatever ` +
            'the spelling or file name: ask the user to allow the folder, or work inside the workspace.',
        );
    }
  }
  return resolved;
}

export function resolveWorkspaceUri(
  filePath: string,
  options: ResolveWorkspacePathOptions = {},
): vscode.Uri {
  const root = options.workspaceRoot ?? defaultWorkspaceRoot();
  if (!root && !path.isAbsolute(filePath)) throw new Error('No workspace folder open.');
  return vscode.Uri.file(resolveWorkspacePath(filePath, options));
}

export interface ResolveRealWorkspacePathOptions {
  /**
   * Allow a target that does not exist yet (a new file or directory). The
   * nearest existing ancestor is real-pathed instead, so a symlink in the
   * parent chain is still caught. Default false: a missing target throws.
   */
  allowMissing?: boolean;
  /** Refuse absolute paths, resolving only against the workspace root. */
  relativeOnly?: boolean;
  /**
   * Absolute folders outside the workspace that also satisfy containment —
   * config.yaml `extra_file_roots`. Passed through to the lexical check and
   * real-pathed here so a symlink that stays inside an extra root is allowed
   * but one that points past it is refused.
   */
  extraRoots?: readonly string[];
}

/**
 * Realpath-aware workspace containment. `resolveWorkspacePath` is lexical and
 * cannot see a symlink or junction inside the workspace that points outside it
 * — every write tool used to trust it, so `write_file` to `link/evil.txt`
 * (where `link` is a junction to `..`) wrote outside the workspace. This
 * resolves the candidate (or, for a not-yet-created target, its nearest
 * existing ancestor) with `fs.realpath` and re-checks containment against the
 * REAL workspace root and any real extra roots. Returns the real path, which
 * is what the tool should actually write.
 */
export async function resolveRealWorkspacePath(
  filePath: string,
  workspaceRoot?: string,
  options: ResolveRealWorkspacePathOptions = {},
): Promise<string> {
  const root = workspaceRoot ?? defaultWorkspaceRoot();
  const extra = options.extraRoots ?? [];
  const resolved = resolveWorkspacePath(filePath, {
    // exactOptionalPropertyTypes: only pass the root when we have one, so an
    // undefined never lands in a `string?` slot.
    ...(root ? { workspaceRoot: root } : {}),
    allowAbsolute: !(options.relativeOnly ?? false),
    mustBeInsideWorkspace: true,
    extraRoots: extra,
  });

  // The lexical check passed (workspace or an extra root). Now confirm the REAL
  // path stays there. A missing extra root contributes nothing: no path inside
  // it can exist, so it cannot be the destination of an escape.
  const realRoots: string[] = [];
  for (const candidate of root ? [root, ...extra] : extra) {
    try {
      realRoots.push(await fs.realpath(candidate));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const insideRealRoot = (p: string): boolean => realRoots.some((r) => isPathInside(r, p));

  try {
    const realCandidate = await fs.realpath(resolved);
    if (!insideRealRoot(realCandidate)) {
      throw new Error(`Path resolves outside the workspace: ${filePath}`);
    }
    return realCandidate;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!options.allowMissing || (code !== 'ENOENT' && code !== 'ENOTDIR')) throw err;
  }

  // Target does not exist yet. Walk up to the nearest existing ancestor and
  // confirm IT stays inside; a symlink in the parent chain surfaces here.
  // Re-append the missing tail so the returned path is the real destination.
  let existing = path.dirname(resolved);
  const suffix: string[] = [path.basename(resolved)];
  while (existing !== path.dirname(existing)) {
    try {
      const realParent = await fs.realpath(existing);
      if (!insideRealRoot(realParent)) {
        throw new Error(`Path parent resolves outside the workspace: ${filePath}`);
      }
      return path.join(realParent, ...suffix.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      suffix.push(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  throw new Error(`No existing workspace parent for path: ${filePath}`);
}
