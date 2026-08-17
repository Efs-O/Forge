import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  type CheckpointCoverage,
  type CheckpointInventory,
  type InventoryEntry,
  inventoryCheckpointCoverage,
} from './CheckpointInventory';
import {
  CHECKPOINT_MANIFEST_VERSION,
  type CommittedCheckpointManifest,
  type DiskCheckpointReference,
  type StoredCheckpointEntry,
  fromManifestPath,
} from './CheckpointManifest';
import {
  FREE_SPACE_RESERVE_BYTES,
  formatCheckpointBytes,
  readAndHashCheckpointFile,
  throwIfCheckpointAborted,
  writeCheckpointJsonAtomic,
} from './CheckpointFileIO';
import { isPathInside } from '../util/pathContainment';
import {
  checkpointEntryChanged,
  checkpointInventoriesMatch,
  minimalCreatedCheckpointPaths,
} from './CheckpointDiff';
import {
  assertCheckpointWithinLimits,
  validateCheckpointLimits,
  type CheckpointLimits,
} from './CheckpointPolicy';
import { getLogger } from '../util/logger';
import { discardDiskCheckpoint, restoreDiskCheckpoint } from './DiskCheckpointRestore';
import { reportExistingCheckpointRecoveryData } from './CheckpointRecovery';

const log = getLogger();

export interface CheckpointProgress {
  phase: 'inventory' | 'capture' | 'finalize';
  completedFiles: number;
  totalFiles: number;
  completedBytes: number;
  totalBytes: number;
}

export interface PreparedDiskCheckpoint {
  finish(): Promise<DiskCheckpointReference | null>;
  discard(): Promise<void>;
}

interface PreparedState {
  checkpointDir: string;
  pendingManifestPath: string;
  turnId: string;
  workspaceRoot: string;
  coverage: CheckpointCoverage;
  baseline: StoredCheckpointEntry[];
  onProgress?: (progress: CheckpointProgress) => void;
}

function storedMetadata(entry: InventoryEntry): StoredCheckpointEntry {
  if (entry.kind === 'directory') {
    return { kind: 'directory', relativePath: entry.relativePath, mode: entry.mode };
  }
  if (entry.kind === 'symlink') {
    return {
      kind: 'symlink',
      relativePath: entry.relativePath,
      target: entry.target,
      linkType: entry.linkType,
    };
  }
  throw new Error('File checkpoint entry requires a stored blob');
}

export class DiskCheckpointStore {
  constructor(
    private readonly storageRoot: string,
    private readonly limits: CheckpointLimits,
  ) {
    validateCheckpointLimits(limits);
    reportExistingCheckpointRecoveryData(storageRoot);
  }

  async prepare(
    turnId: string,
    workspaceRoot: string,
    coverage: CheckpointCoverage,
    signal: AbortSignal,
    onProgress?: (progress: CheckpointProgress) => void,
  ): Promise<PreparedDiskCheckpoint> {
    const startedAt = Date.now();
    const inventory = await inventoryCheckpointCoverage(
      workspaceRoot,
      coverage,
      signal,
      'inventory',
      (progress) =>
        onProgress?.({
          phase: 'inventory',
          completedFiles: progress.fileCount,
          totalFiles: progress.fileCount,
          completedBytes: progress.totalBytes,
          totalBytes: progress.totalBytes,
        }),
    );
    assertCheckpointWithinLimits(inventory, this.limits);
    await this.assertStorageCapacity(inventory);
    const checkpointDir = await fs.promises.mkdtemp(path.join(this.storageRoot, 'turn-'));
    try {
      const blobsDir = path.join(checkpointDir, 'blobs');
      await fs.promises.mkdir(blobsDir);
      const baseline: StoredCheckpointEntry[] = [];
      let completedFiles = 0;
      let completedBytes = 0;
      for (const entry of inventory.entries) {
        throwIfCheckpointAborted(signal);
        if (entry.kind !== 'file') {
          baseline.push(storedMetadata(entry));
          continue;
        }
        const blobName = `${crypto.createHash('sha256').update(entry.relativePath).digest('hex')}.bin`;
        const blobPath = `blobs/${blobName}`;
        const sha256 = await readAndHashCheckpointFile(
          entry.absolutePath,
          path.join(blobsDir, blobName),
          entry,
          signal,
        );
        baseline.push({
          kind: 'file',
          relativePath: entry.relativePath,
          blobPath,
          sha256,
          size: entry.size,
          mode: entry.mode,
        });
        completedFiles += 1;
        completedBytes += entry.size;
        onProgress?.({
          phase: 'capture',
          completedFiles,
          totalFiles: inventory.fileCount,
          completedBytes,
          totalBytes: inventory.totalBytes,
        });
      }
      const verifiedInventory = await inventoryCheckpointCoverage(
        workspaceRoot,
        coverage,
        signal,
        'inventory',
      );
      if (!checkpointInventoriesMatch(inventory, verifiedInventory)) {
        throw new Error(
          'Workspace changed while Forge was preparing rollback coverage; retry the turn.',
        );
      }
      log.info(
        `[Checkpoint] prepared turn=${turnId} files=${inventory.fileCount} bytes=${inventory.totalBytes} durationMs=${Date.now() - startedAt}`,
      );
      const pendingManifestPath = path.join(checkpointDir, 'manifest.pending.json');
      await writeCheckpointJsonAtomic(pendingManifestPath, {
        version: CHECKPOINT_MANIFEST_VERSION,
        status: 'pending',
        turnId,
        workspaceRoot: inventory.workspaceRoot,
        createdAt: Date.now(),
        coverage,
        baseline,
      });
      const state: PreparedState = {
        checkpointDir,
        pendingManifestPath,
        turnId,
        workspaceRoot: inventory.workspaceRoot,
        coverage,
        baseline,
        ...(onProgress ? { onProgress } : {}),
      };
      return this.preparedHandle(state);
    } catch (err) {
      await fs.promises.rm(checkpointDir, { recursive: true, force: true });
      throw err;
    }
  }

  restore(reference: DiskCheckpointReference): Promise<string[]> {
    return restoreDiskCheckpoint(reference);
  }

  discard(reference: DiskCheckpointReference): Promise<void> {
    return discardDiskCheckpoint(reference);
  }

  private preparedHandle(state: PreparedState): PreparedDiskCheckpoint {
    let settled = false;
    return {
      finish: async () => {
        if (settled) throw new Error('Checkpoint capture already finalized');
        settled = true;
        try {
          return await this.finalize(state);
        } catch (err) {
          throw new Error(
            `Forge could not finalize rollback coverage. Recovery data is retained at ${state.checkpointDir}. ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      },
      discard: async () => {
        if (settled) return;
        settled = true;
        await fs.promises.rm(state.checkpointDir, { recursive: true, force: true });
      },
    };
  }

  private async finalize(state: PreparedState): Promise<DiskCheckpointReference | null> {
    const startedAt = Date.now();
    const neverAborted = new AbortController().signal;
    const current = await inventoryCheckpointCoverage(
      state.workspaceRoot,
      state.coverage,
      neverAborted,
      'finalize',
    );
    const currentByPath = new Map(current.entries.map((entry) => [entry.relativePath, entry]));
    const baselineByPath = new Map(state.baseline.map((entry) => [entry.relativePath, entry]));
    const currentHashes = new Map<string, string>();
    let completedFiles = 0;
    let completedBytes = 0;
    for (const entry of current.entries) {
      const original = baselineByPath.get(entry.relativePath);
      if (entry.kind !== 'file' || original?.kind !== 'file') continue;
      currentHashes.set(
        entry.relativePath,
        await readAndHashCheckpointFile(entry.absolutePath, undefined, entry, neverAborted),
      );
      completedFiles += 1;
      completedBytes += entry.size;
      state.onProgress?.({
        phase: 'finalize',
        completedFiles,
        totalFiles: current.fileCount,
        completedBytes,
        totalBytes: current.totalBytes,
      });
    }
    const verifiedCurrent = await inventoryCheckpointCoverage(
      state.workspaceRoot,
      state.coverage,
      neverAborted,
      'finalize',
    );
    if (!checkpointInventoriesMatch(current, verifiedCurrent)) {
      throw new Error(
        `Workspace changed while Forge was finalizing rollback coverage. Recovery data is retained at ${state.checkpointDir}.`,
      );
    }
    const originalEntries = state.baseline.filter((entry) =>
      checkpointEntryChanged(
        entry,
        currentByPath.get(entry.relativePath),
        currentHashes.get(entry.relativePath),
      ),
    );
    const changedSet = new Set(originalEntries.map((entry) => entry.relativePath));
    const createdPaths = minimalCreatedCheckpointPaths(
      current.entries
        .filter((entry) => !baselineByPath.has(entry.relativePath))
        .map((entry) => entry.relativePath),
    );
    if (originalEntries.length === 0 && createdPaths.length === 0) {
      await fs.promises.rm(state.checkpointDir, { recursive: true, force: true });
      log.info(
        `[Checkpoint] finalized turn=${state.turnId} changed=0 durationMs=${Date.now() - startedAt}`,
      );
      return null;
    }
    for (const entry of state.baseline) {
      if (entry.kind === 'file' && !changedSet.has(entry.relativePath)) {
        await fs.promises.rm(path.join(state.checkpointDir, fromManifestPath(entry.blobPath)), {
          force: true,
        });
      }
    }
    const manifest: CommittedCheckpointManifest = {
      version: CHECKPOINT_MANIFEST_VERSION,
      status: 'committed',
      turnId: state.turnId,
      workspaceRoot: state.workspaceRoot,
      createdAt: Date.now(),
      originalEntries,
      createdPaths,
    };
    const manifestPath = path.join(state.checkpointDir, 'manifest.committed.json');
    await writeCheckpointJsonAtomic(manifestPath, manifest);
    await fs.promises.rm(state.pendingManifestPath, { force: true });
    const changedPaths = [...new Set([...changedSet, ...createdPaths])].map((relativePath) =>
      this.resolveWorkspaceTarget(state.workspaceRoot, relativePath),
    );
    log.info(
      `[Checkpoint] finalized turn=${state.turnId} changed=${changedPaths.length} durationMs=${Date.now() - startedAt}`,
    );
    return {
      checkpointDir: state.checkpointDir,
      manifestPath,
      workspaceRoot: state.workspaceRoot,
      changedPaths,
    };
  }

  private async assertStorageCapacity(inventory: CheckpointInventory): Promise<void> {
    await fs.promises.mkdir(this.storageRoot, { recursive: true });
    if (isPathInside(inventory.workspaceRoot, path.resolve(this.storageRoot))) {
      throw new Error('Forge checkpoint storage must be outside the workspace');
    }
    const stats = await fs.promises.statfs(this.storageRoot);
    const availableBytes = stats.bavail * stats.bsize;
    if (availableBytes < inventory.totalBytes + FREE_SPACE_RESERVE_BYTES) {
      throw new Error(
        `Forge did not start the external CLI. Checkpoint storage has ${formatCheckpointBytes(availableBytes)} free but requires at least ${formatCheckpointBytes(inventory.totalBytes + FREE_SPACE_RESERVE_BYTES)}.`,
      );
    }
  }

  private resolveWorkspaceTarget(root: string, relativePath: string): string {
    const target = path.resolve(root, fromManifestPath(relativePath));
    if (target === root || !isPathInside(root, target))
      throw new Error('Checkpoint target escapes workspace');
    return target;
  }
}
