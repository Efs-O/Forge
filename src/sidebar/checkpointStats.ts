import * as fs from 'fs';
import type { CheckpointStats } from './diffMessages';
import { diffStats } from './diffMessages';
import { diffContents } from './DiffUtils';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { CheckpointReadyMsg } from './messageBridge';

/** Current text of a checkpointed path: null when it is gone, undefined for a directory. */
function readCurrent(filePath: string): string | null | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return stat.isDirectory() ? undefined : fs.readFileSync(filePath, 'utf8');
}

/**
 * The checkpoint bar's numbers: each snapshotted file now against its pre-turn
 * contents. Summing the transcript's per-write diffs instead counted a file
 * once per write and every line a later write touched again, so a new
 * 2,137-line file edited a few times read +2,327.
 */
export function computeCheckpointStats(
  entries: Array<{ filePath: string; original: string | null }>,
): CheckpointStats {
  const stats: CheckpointStats = { fileCount: 0, added: 0, removed: 0, uncountedFiles: 0 };
  for (const entry of entries) {
    const current = readCurrent(entry.filePath);
    if (current === undefined || current === entry.original) continue;
    stats.fileCount++;
    const hunks = diffContents(entry.original ?? '', current ?? '');
    if (hunks === null) {
      stats.uncountedFiles++;
      continue;
    }
    const { added, removed } = diffStats(hunks);
    stats.added += added;
    stats.removed += removed;
  }
  return stats;
}

/** The `checkpointReady` message for a conversation's newest checkpoint. */
export function checkpointReadyMessage(
  checkpoints: CheckpointStack,
  conversationId: string,
): CheckpointReadyMsg {
  return {
    type: 'checkpointReady',
    conversationId,
    stats: computeCheckpointStats(checkpoints.pendingSnapshots(conversationId)),
  };
}
