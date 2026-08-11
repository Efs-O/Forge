import type { CheckpointSession, WorkspaceCheckpointCapture } from '../checkpoint/CheckpointStack';
import type { CheckpointProgress } from '../checkpoint/DiskCheckpointStore';

export type { WorkspaceCheckpointCapture } from '../checkpoint/CheckpointStack';

/** Creates a bounded, disk-backed workspace checkpoint before a full-access CLI starts. */
export async function snapshotWorkspaceBefore(
  checkpoint: CheckpointSession,
  workspaceRoot: string,
  signal: AbortSignal,
  onProgress?: (progress: CheckpointProgress) => void,
): Promise<WorkspaceCheckpointCapture> {
  return checkpoint.prepareWorkspace(workspaceRoot, signal, onProgress);
}
