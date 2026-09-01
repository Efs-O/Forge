/**
 * Finds the user's other projects for `/workspace list` without any config.
 *
 * Telegram is served by one window, and the only way to move it is
 * `/new <alias>` against `remote.workspace_aliases` — a block that is empty on
 * every install, so the feature was unreachable by default. Asking someone to
 * hand-write four path/display pairs before it does anything is exactly why.
 *
 * The search root is derived, never configured and never hardcoded: the parent
 * of the folder this window has open. For `N:\vs code apps\Forge` that is
 * `N:\vs code apps`; for `~/dev/thing` it is `~/dev`. Correct for every user,
 * right on first run.
 */

import * as fs from 'fs';
import * as path from 'path';

/** A user whose project sits directly in their home directory should get a
 *  bounded list rather than a stat() storm. */
const MAX_DISCOVERED = 100;

const IGNORED = new Set(['node_modules', '__pycache__', 'venv', '.venv']);

export interface WorkspaceAliasTarget {
  path: string;
  display_name: string;
}

/**
 * Deliberately no `.git` filter. It was the obvious refinement and it is wrong:
 * on the disk that prompted this, the parent holds 29 directories, 13 of them
 * repositories — and `Qwen testing`, the folder whose absence started the whole
 * investigation, is not one. A filter that hides the motivating case is not a
 * refinement.
 */
export function discoverSiblingWorkspaces(
  workspaceRoot: string | undefined,
): Record<string, WorkspaceAliasTarget> {
  if (!workspaceRoot) return {};
  const root = path.resolve(workspaceRoot);
  const parent = path.dirname(root);
  // A drive or filesystem root has no meaningful siblings to offer.
  if (parent === root) return {};

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    // An unreadable parent is not an error worth surfacing: it just means this
    // window cannot offer discovery, and explicit aliases still work.
    return {};
  }

  const discovered: Record<string, WorkspaceAliasTarget> = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (Object.keys(discovered).length >= MAX_DISCOVERED) break;
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || IGNORED.has(entry.name.toLowerCase())) continue;
    const alias = aliasFor(entry.name);
    // First name wins; two folders slugging to one alias is rare and the loser
    // is still reachable through an explicit entry.
    if (!alias || discovered[alias]) continue;
    discovered[alias] = { path: path.join(parent, entry.name), display_name: entry.name };
  }
  return discovered;
}

/**
 * Explicit config always wins, so `remote.workspace_aliases` keeps its current
 * meaning: it pins a display name, or reaches a project that does not live
 * beside the current one. An explicit entry pointing at a discovered directory
 * replaces it rather than listing the same folder twice.
 */
export function resolveWorkspaceAliases(
  configured: Readonly<Record<string, WorkspaceAliasTarget>>,
  workspaceRoot: string | undefined,
): Record<string, WorkspaceAliasTarget> {
  const merged = discoverSiblingWorkspaces(workspaceRoot);
  const configuredPaths = new Set(
    Object.values(configured).map((target) => path.resolve(target.path).toLowerCase()),
  );
  for (const [alias, target] of Object.entries(merged)) {
    if (configuredPaths.has(path.resolve(target.path).toLowerCase())) delete merged[alias];
  }
  return { ...merged, ...configured };
}

/** Must satisfy the `workspace_aliases` key regex so a discovered alias and a
 *  configured one are interchangeable everywhere downstream. */
function aliasFor(folderName: string): string | undefined {
  const slug = folderName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  if (!slug) return undefined;
  return /^[a-z]/.test(slug) ? slug : `w-${slug}`.slice(0, 32);
}
