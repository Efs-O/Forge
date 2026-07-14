import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ResolveWorkspacePathOptions {
  workspaceRoot?: string;
  allowAbsolute?: boolean;
  mustBeInsideWorkspace?: boolean;
}

function defaultWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
      : path.normalize(filePath);
  if (options.mustBeInsideWorkspace) {
    if (!root) throw new Error('No workspace folder open');
    if (!isPathInside(root, resolved))
      throw new Error(`Path is outside the workspace: ${filePath}`);
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

export async function resolveRealWorkspacePath(
  filePath: string,
  workspaceRoot: string,
  options: { allowMissing?: boolean; relativeOnly?: boolean } = {},
): Promise<string> {
  const resolved = resolveWorkspacePath(filePath, {
    workspaceRoot,
    allowAbsolute: !(options.relativeOnly ?? false),
    mustBeInsideWorkspace: true,
  });
  const realRoot = await fs.realpath(workspaceRoot);
  try {
    const realCandidate = await fs.realpath(resolved);
    if (!isPathInside(realRoot, realCandidate)) {
      throw new Error(`Path resolves outside the workspace: ${filePath}`);
    }
    return realCandidate;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!options.allowMissing || (code !== 'ENOENT' && code !== 'ENOTDIR')) throw err;
  }

  let existing = path.dirname(resolved);
  const suffix: string[] = [path.basename(resolved)];
  while (existing !== path.dirname(existing)) {
    try {
      const realParent = await fs.realpath(existing);
      if (!isPathInside(realRoot, realParent)) {
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
