import type { Checkpoint } from './CheckpointStack';
import type { DiskCheckpointReference } from './CheckpointManifest';

/**
 * Undo history kept per conversation. Snapshots hold original file contents in
 * memory, and a checkpoint is only released by Keep or Undo — a user who never
 * dismisses the bar would otherwise grow the stack for the life of the window.
 * Trimming the oldest preserves recent undo depth, which finalising on every new
 * turn would not.
 */
export const MAX_CHECKPOINT_DEPTH = 20;

/**
 * Trims a stack to the depth cap, returning the disk references belonging to the
 * evicted checkpoints so the caller can release them.
 */
export function evictBeyondDepth(stack: Checkpoint[]): DiskCheckpointReference[] {
  const orphaned: DiskCheckpointReference[] = [];
  while (stack.length > MAX_CHECKPOINT_DEPTH) {
    const evicted = stack.shift();
    orphaned.push(...(evicted?.diskSnapshots ?? []));
  }
  return orphaned;
}

/** Pre-turn contents of a checkpoint's files; `null` means it did not exist. */
export function snapshotContents(
  checkpoint: Checkpoint | undefined,
): Array<{ filePath: string; original: string | null }> {
  if (!checkpoint) return [];
  return checkpoint.snapshots.map((snapshot) => ({
    filePath: snapshot.filePath,
    original:
      snapshot.originalState.kind === 'file'
        ? snapshot.originalState.content.toString('utf8')
        : null,
  }));
}
