import { formatCheckpointBytes } from './CheckpointFileIO';

export interface CheckpointLimits {
  maxBytes: number;
  maxFiles: number;
}

/** Safe defaults for programmatic consumers that do not receive VS Code settings. */
export const DEFAULT_CHECKPOINT_LIMITS: CheckpointLimits = {
  maxBytes: 512 * 1024 * 1024,
  maxFiles: 20_000,
};

export interface CheckpointMeasurement {
  totalBytes: number;
  fileCount: number;
}

export function validateCheckpointLimits(limits: CheckpointLimits): void {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new Error('Forge checkpoint maxBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1) {
    throw new Error('Forge checkpoint maxFiles must be a positive safe integer');
  }
}

export function assertCheckpointWithinLimits(
  measurement: CheckpointMeasurement,
  limits: CheckpointLimits,
): void {
  if (measurement.totalBytes > limits.maxBytes) {
    throw new Error(
      `Forge did not start the external CLI. Rollback coverage requires ${formatCheckpointBytes(measurement.totalBytes)} across ${measurement.fileCount} files, exceeding forge.checkpoint.maxBytes (${formatCheckpointBytes(limits.maxBytes)}). Open a smaller workspace or raise the reviewed checkpoint limit.`,
    );
  }
  if (measurement.fileCount > limits.maxFiles) {
    throw new Error(
      `Forge did not start the external CLI. Rollback coverage requires ${measurement.fileCount} files, exceeding forge.checkpoint.maxFiles (${limits.maxFiles}).`,
    );
  }
}
