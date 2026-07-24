import * as fs from 'fs';
import * as path from 'path';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';

// External agents may operate anywhere in the workspace. VCS metadata and
// dependency environments are intentionally excluded: restoring those by
// deleting and recreating them would be unsafe and unnecessarily expensive.
const EXCLUDED_TOP_LEVEL = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv']);

function isExcludedTopLevel(name: string): boolean {
  const lower = name.toLowerCase();
  // Forge's live config/state is extension infrastructure, not an agent edit.
  // It may also be held open by the config watcher, so checkpoint restoration
  // must never delete and recreate it.
  return lower === '.forge' || lower.startsWith('.forge-') || EXCLUDED_TOP_LEVEL.has(lower);
}

export interface WorkspaceCheckpointCapture {
  finish(): void;
}

function visibleTopLevelNames(workspaceRoot: string): Set<string> {
  return new Set(fs.readdirSync(workspaceRoot).filter((name) => !isExcludedTopLevel(name)));
}

/** Snapshots each workspace top-level entry before an external CLI receives
 * full access. Existing directories capture their complete subtree. `finish`
 * records newly-created top-level entries as originally missing. */
export function snapshotWorkspaceBefore(
  checkpoint: CheckpointSession,
  workspaceRoot: string,
): WorkspaceCheckpointCapture {
  const root = path.resolve(workspaceRoot);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`Forge: workspace root is not a directory: ${root}`);

  const before = visibleTopLevelNames(root);
  for (const name of before) checkpoint.snapshotBefore(path.join(root, name));

  return {
    finish(): void {
      for (const name of visibleTopLevelNames(root)) {
        if (!before.has(name)) checkpoint.snapshotMissingBefore(path.join(root, name));
      }
    },
  };
}
