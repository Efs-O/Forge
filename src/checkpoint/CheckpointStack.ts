import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface FileSnapshot {
  filePath: string;
  /** Original content, or null if the file did not exist before this turn. */
  originalContent: string | null;
}

export interface Checkpoint {
  turnId: string;
  snapshots: FileSnapshot[];
  createdAt: number;
}

/**
 * Per-turn checkpoint stack. Before any write tool executes, the agent
 * snapshots the target file here. The user can Undo to restore the snapshot
 * or Keep to discard it.
 *
 * Only stores content in memory — suitable for files up to a few MB.
 * For larger files a disk-based approach should be used in a future version.
 */
export class CheckpointStack {
  private readonly stack: Checkpoint[] = [];
  private currentTurnId: string | null = null;
  private pendingSnapshots: FileSnapshot[] = [];

  /** Call at the start of each agent turn before any tool runs. */
  beginTurn(turnId: string): void {
    this.currentTurnId = turnId;
    this.pendingSnapshots = [];
  }

  /**
   * Snapshot a file before it is written. Idempotent within a turn —
   * only the first snapshot per file per turn is kept.
   */
  snapshotBefore(filePath: string): void {
    const abs = path.resolve(filePath);
    const alreadyCaptured = this.pendingSnapshots.some((s) => s.filePath === abs);
    if (alreadyCaptured) return;

    let originalContent: string | null = null;
    if (fs.existsSync(abs)) {
      try {
        originalContent = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        log.warn(`[CheckpointStack] could not read ${abs}: ${(err as Error).message}`);
      }
    }
    this.pendingSnapshots.push({ filePath: abs, originalContent });
    log.debug(`[CheckpointStack] snapshotted ${abs}`);
  }

  /** Commit the pending snapshots as a checkpoint for the current turn. */
  commitTurn(): void {
    if (!this.currentTurnId || this.pendingSnapshots.length === 0) return;
    this.stack.push({
      turnId: this.currentTurnId,
      snapshots: [...this.pendingSnapshots],
      createdAt: Date.now(),
    });
    this.pendingSnapshots = [];
    this.currentTurnId = null;
    log.debug(`[CheckpointStack] committed, depth=${this.stack.length}`);
  }

  /** Restore the most recent checkpoint and remove it from the stack. */
  undo(): string[] {
    const checkpoint = this.stack.pop();
    if (!checkpoint) throw new Error('CheckpointStack: nothing to undo');

    const restored: string[] = [];
    for (const snap of checkpoint.snapshots) {
      try {
        if (snap.originalContent === null) {
          if (fs.existsSync(snap.filePath)) fs.unlinkSync(snap.filePath);
        } else {
          fs.mkdirSync(path.dirname(snap.filePath), { recursive: true });
          fs.writeFileSync(snap.filePath, snap.originalContent, 'utf8');
        }
        restored.push(snap.filePath);
      } catch (err) {
        log.error(`[CheckpointStack] undo failed for ${snap.filePath}: ${(err as Error).message}`);
      }
    }
    log.info(`[CheckpointStack] undid turn ${checkpoint.turnId}, restored ${restored.length} file(s)`);
    return restored;
  }

  /** Discard the most recent checkpoint without restoring (user chose Keep). */
  keep(): void {
    if (!this.stack.pop()) throw new Error('CheckpointStack: nothing to keep');
    log.debug(`[CheckpointStack] kept, depth=${this.stack.length}`);
  }

  depth(): number { return this.stack.length; }

  canUndo(): boolean { return this.stack.length > 0; }
}
