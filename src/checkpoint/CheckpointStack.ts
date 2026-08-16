import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { getLogger } from '../util/logger';
import { coverageForPaths } from './CheckpointInventory';
import {
  DiskCheckpointStore,
  type CheckpointProgress,
  type PreparedDiskCheckpoint,
} from './DiskCheckpointStore';
import type { DiskCheckpointReference } from './CheckpointManifest';
import type { CheckpointLimits } from './CheckpointPolicy';
import { evictBeyondDepth, snapshotContents } from './checkpointHistory';
import {
  captureMemoryState,
  restoreMemoryState,
  type MemorySnapshotState,
} from './MemoryCheckpointState';

const log = getLogger();

export interface FileSnapshot {
  filePath: string;
  originalState: MemorySnapshotState;
}

export interface Checkpoint {
  turnId: string;
  conversationId: string;
  snapshots: FileSnapshot[];
  diskSnapshots: DiskCheckpointReference[];
  createdAt: number;
}

export interface WorkspaceCheckpointCapture {
  finish(): Promise<void>;
  discard(): Promise<void>;
}

export interface CheckpointStackOptions {
  storageRoot?: string;
  limits?: CheckpointLimits;
  externalCliRollbackEnabled?: boolean;
}

const DEFAULT_CONVERSATION_ID = '__default__';

export { MAX_CHECKPOINT_DEPTH } from './checkpointHistory';

export class CheckpointSession {
  private readonly pendingSnapshots: FileSnapshot[] = [];
  private readonly pendingDiskSnapshots: DiskCheckpointReference[] = [];
  private committed = false;

  constructor(
    readonly turnId: string,
    readonly conversationId: string,
    private readonly captureState: (target: string) => MemorySnapshotState,
    private readonly onCommit: (session: CheckpointSession) => void,
    private readonly diskStore: DiskCheckpointStore,
    readonly externalCliRollbackEnabled: boolean,
  ) {}

  snapshotBefore(filePath: string): void {
    if (this.committed) throw new Error('CheckpointSession: turn already committed');
    const abs = path.resolve(filePath);
    if (this.pendingSnapshots.some((snapshot) => snapshot.filePath === abs)) return;
    this.pendingSnapshots.push({ filePath: abs, originalState: this.captureState(abs) });
    log.debug(`[CheckpointStack] snapshotted ${abs}`);
  }

  /** Records a path that did not exist when the turn began. This is used for
   * processes whose writes happen outside Forge's tool dispatcher: after the
   * process exits, newly-created top-level paths can still be removed by Undo. */
  snapshotMissingBefore(filePath: string): void {
    if (this.committed) throw new Error('CheckpointSession: turn already committed');
    const abs = path.resolve(filePath);
    if (this.pendingSnapshots.some((snapshot) => snapshot.filePath === abs)) return;
    this.pendingSnapshots.push({ filePath: abs, originalState: { kind: 'missing' } });
    log.debug(`[CheckpointStack] recorded missing-before ${abs}`);
  }

  readSnapshotContent(filePath: string): string | null | undefined {
    const abs = path.resolve(filePath);
    const snapshot = this.pendingSnapshots.find((candidate) => candidate.filePath === abs);
    if (!snapshot) return undefined;
    if (snapshot.originalState.kind === 'missing') return null;
    if (snapshot.originalState.kind === 'file')
      return snapshot.originalState.content.toString('utf8');
    return undefined;
  }

  async prepareWorkspace(
    workspaceRoot: string,
    signal: AbortSignal,
    onProgress?: (progress: CheckpointProgress) => void,
  ): Promise<WorkspaceCheckpointCapture> {
    if (!this.externalCliRollbackEnabled) return disabledWorkspaceCapture();
    return this.prepareDiskCheckpoint(
      this.diskStore.prepare(this.turnId, workspaceRoot, { kind: 'workspace' }, signal, onProgress),
    );
  }

  async preparePaths(
    workspaceRoot: string,
    targets: readonly string[],
    signal: AbortSignal,
    onProgress?: (progress: CheckpointProgress) => void,
  ): Promise<WorkspaceCheckpointCapture> {
    if (!this.externalCliRollbackEnabled) return disabledWorkspaceCapture();
    return this.prepareDiskCheckpoint(
      this.diskStore.prepare(
        this.turnId,
        workspaceRoot,
        coverageForPaths(workspaceRoot, targets),
        signal,
        onProgress,
      ),
    );
  }

  commit(): void {
    if (this.committed) return;
    this.committed = true;
    this.onCommit(this);
  }

  snapshots(): readonly FileSnapshot[] {
    return this.pendingSnapshots;
  }

  diskSnapshots(): readonly DiskCheckpointReference[] {
    return this.pendingDiskSnapshots;
  }

  private async prepareDiskCheckpoint(
    pending: Promise<PreparedDiskCheckpoint>,
  ): Promise<WorkspaceCheckpointCapture> {
    if (this.committed) throw new Error('CheckpointSession: turn already committed');
    const prepared = await pending;
    return {
      finish: async () => {
        if (this.committed) throw new Error('CheckpointSession: turn already committed');
        const reference = await prepared.finish();
        if (reference) this.pendingDiskSnapshots.push(reference);
      },
      discard: () => prepared.discard(),
    };
  }
}

/** Per-conversation Keep/Undo stacks. Whole-workspace CLI snapshots are disk-backed. */
export class CheckpointStack {
  private readonly stacks = new Map<string, Checkpoint[]>();
  private legacySession: CheckpointSession | null = null;
  private readonly diskStore: DiskCheckpointStore;
  private readonly externalCliRollbackEnabled: boolean;

  constructor(options: CheckpointStackOptions = {}) {
    this.externalCliRollbackEnabled = options.externalCliRollbackEnabled ?? true;
    this.diskStore = new DiskCheckpointStore(
      options.storageRoot ?? path.join(os.tmpdir(), `forge-checkpoints-${process.pid}`),
      options.limits ?? { maxBytes: Number.MAX_SAFE_INTEGER, maxFiles: Number.MAX_SAFE_INTEGER },
    );
  }

  beginTurn(turnId: string, conversationId = DEFAULT_CONVERSATION_ID): CheckpointSession {
    const session = new CheckpointSession(
      turnId,
      conversationId,
      (target) => captureMemoryState(target),
      (completed) => this.commitSession(completed),
      this.diskStore,
      this.externalCliRollbackEnabled,
    );
    this.legacySession = session;
    return session;
  }

  snapshotBefore(filePath: string): void {
    if (!this.legacySession) throw new Error('CheckpointStack: no active turn');
    this.legacySession.snapshotBefore(filePath);
  }

  commitTurn(session: CheckpointSession | null = this.legacySession): void {
    session?.commit();
    if (this.legacySession === session) this.legacySession = null;
  }

  private commitSession(session: CheckpointSession): void {
    const changed = session.snapshots().filter((snapshot) => {
      try {
        return !isDeepStrictEqual(snapshot.originalState, captureMemoryState(snapshot.filePath));
      } catch {
        // If the current path cannot be inspected, retain the original state so
        // Undo remains the safe operation.
        return true;
      }
    });
    const diskSnapshots = [...session.diskSnapshots()];
    if (changed.length === 0 && diskSnapshots.length === 0) return;
    const stack = this.stackFor(session.conversationId);
    stack.push({
      turnId: session.turnId,
      conversationId: session.conversationId,
      snapshots: changed,
      diskSnapshots,
      createdAt: Date.now(),
    });
    for (const reference of evictBeyondDepth(stack)) {
      void this.diskStore.discard(reference).catch((err: Error) => {
        log.error(`[CheckpointStack] evicting oldest checkpoint failed: ${err.message}`);
      });
    }
    log.debug(
      `[CheckpointStack] committed conversation=${session.conversationId}, depth=${this.depth(session.conversationId)}`,
    );
  }

  async undo(conversationId = DEFAULT_CONVERSATION_ID): Promise<string[]> {
    const stack = this.stackFor(conversationId);
    const checkpoint = stack.at(-1);
    if (!checkpoint) throw new Error('CheckpointStack: nothing to undo');

    const restored: string[] = [];
    const failures: Error[] = [];
    for (const snapshot of checkpoint.snapshots) {
      try {
        restoreMemoryState(snapshot.filePath, snapshot.originalState);
        restored.push(snapshot.filePath);
      } catch (err) {
        failures.push(err instanceof Error ? err : new Error(String(err)));
        log.error(
          `[CheckpointStack] undo failed for ${snapshot.filePath}: ${(err as Error).message}`,
        );
      }
    }
    for (const reference of checkpoint.diskSnapshots) {
      try {
        restored.push(...(await this.diskStore.restore(reference)));
      } catch (err) {
        failures.push(err instanceof Error ? err : new Error(String(err)));
        log.error(`[CheckpointStack] disk undo failed: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'CheckpointStack: Undo was incomplete; recovery data retained',
      );
    }
    stack.pop();
    for (const reference of checkpoint.diskSnapshots) {
      try {
        await this.diskStore.discard(reference);
      } catch (err) {
        log.error(`[CheckpointStack] undo succeeded but cleanup failed: ${(err as Error).message}`);
      }
    }
    log.info(
      `[CheckpointStack] undid turn ${checkpoint.turnId}, restored ${restored.length} path(s)`,
    );
    return [...new Set(restored)];
  }

  async keep(conversationId = DEFAULT_CONVERSATION_ID): Promise<void> {
    const stack = this.stackFor(conversationId);
    const checkpoint = stack.pop();
    if (!checkpoint) throw new Error('CheckpointStack: nothing to keep');
    for (const reference of checkpoint.diskSnapshots) {
      try {
        await this.diskStore.discard(reference);
      } catch (err) {
        log.error(`[CheckpointStack] kept changes but cleanup failed: ${(err as Error).message}`);
      }
    }
    log.debug(`[CheckpointStack] kept conversation=${conversationId}, depth=${stack.length}`);
  }

  readSnapshotContent(filePath: string): string | null | undefined {
    return this.legacySession?.readSnapshotContent(filePath);
  }

  /**
   * Pre-turn contents of the files the newest checkpoint covers, for review
   * without consuming it. `null` content means the file did not exist before.
   */
  pendingSnapshots(
    conversationId = DEFAULT_CONVERSATION_ID,
  ): Array<{ filePath: string; original: string | null }> {
    return snapshotContents(this.stackFor(conversationId).at(-1));
  }

  depth(conversationId = DEFAULT_CONVERSATION_ID): number {
    return this.stackFor(conversationId).length;
  }
  canUndo(conversationId = DEFAULT_CONVERSATION_ID): boolean {
    return this.depth(conversationId) > 0;
  }

  async disposeConversation(conversationId: string): Promise<void> {
    const checkpoints = this.stacks.get(conversationId) ?? [];
    for (const checkpoint of checkpoints) {
      for (const reference of checkpoint.diskSnapshots) {
        try {
          await this.diskStore.discard(reference);
        } catch (err) {
          log.error(`[CheckpointStack] conversation cleanup failed: ${(err as Error).message}`);
        }
      }
    }
    this.stacks.delete(conversationId);
  }

  async dispose(): Promise<void> {
    for (const conversationId of [...this.stacks.keys()]) {
      await this.disposeConversation(conversationId);
    }
    this.legacySession = null;
  }

  private stackFor(conversationId: string): Checkpoint[] {
    const existing = this.stacks.get(conversationId);
    if (existing) return existing;
    const created: Checkpoint[] = [];
    this.stacks.set(conversationId, created);
    return created;
  }
}

function disabledWorkspaceCapture(): WorkspaceCheckpointCapture {
  return {
    finish: async () => undefined,
    discard: async () => undefined,
  };
}
