import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../util/logger';

const log = getLogger();

type LeafState =
  | { kind: 'file'; content: Buffer }
  | { kind: 'directory' }
  | { kind: 'symlink'; target: string };

interface DirectoryEntry {
  relativePath: string;
  state: LeafState;
}

type SnapshotState =
  | { kind: 'missing' }
  | { kind: 'file'; content: Buffer }
  | { kind: 'directory'; entries: DirectoryEntry[] }
  | { kind: 'symlink'; target: string };

export interface FileSnapshot {
  filePath: string;
  originalState: SnapshotState;
}

export interface Checkpoint {
  turnId: string;
  snapshots: FileSnapshot[];
  createdAt: number;
}

/** In-memory, per-turn snapshots used by the Keep/Undo workflow. */
export class CheckpointStack {
  private readonly stack: Checkpoint[] = [];
  private currentTurnId: string | null = null;
  private pendingSnapshots: FileSnapshot[] = [];

  beginTurn(turnId: string): void {
    this.currentTurnId = turnId;
    this.pendingSnapshots = [];
  }

  snapshotBefore(filePath: string): void {
    const abs = path.resolve(filePath);
    if (this.pendingSnapshots.some((snapshot) => snapshot.filePath === abs)) return;
    this.pendingSnapshots.push({ filePath: abs, originalState: this.capture(abs) });
    log.debug(`[CheckpointStack] snapshotted ${abs}`);
  }

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

  undo(): string[] {
    const checkpoint = this.stack.pop();
    if (!checkpoint) throw new Error('CheckpointStack: nothing to undo');

    const restored: string[] = [];
    for (const snapshot of checkpoint.snapshots) {
      try {
        this.restore(snapshot.filePath, snapshot.originalState);
        restored.push(snapshot.filePath);
      } catch (err) {
        log.error(
          `[CheckpointStack] undo failed for ${snapshot.filePath}: ${(err as Error).message}`,
        );
      }
    }
    log.info(
      `[CheckpointStack] undid turn ${checkpoint.turnId}, restored ${restored.length} path(s)`,
    );
    return restored;
  }

  keep(): void {
    if (!this.stack.pop()) throw new Error('CheckpointStack: nothing to keep');
    log.debug(`[CheckpointStack] kept, depth=${this.stack.length}`);
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

  depth(): number {
    return this.stack.length;
  }
  canUndo(): boolean {
    return this.stack.length > 0;
  }

  private capture(target: string): SnapshotState {
    if (!fs.existsSync(target)) return { kind: 'missing' };
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(target) };
    if (stat.isFile()) return { kind: 'file', content: fs.readFileSync(target) };
    if (!stat.isDirectory()) throw new Error(`CheckpointStack: unsupported path type ${target}`);

    const entries: DirectoryEntry[] = [];
    const walk = (directory: string, relativeDirectory: string): void => {
      for (const name of fs.readdirSync(directory)) {
        const absolute = path.join(directory, name);
        const relativePath = path.join(relativeDirectory, name);
        const entryStat = fs.lstatSync(absolute);
        if (entryStat.isDirectory()) {
          entries.push({ relativePath, state: { kind: 'directory' } });
          walk(absolute, relativePath);
        } else if (entryStat.isSymbolicLink()) {
          entries.push({
            relativePath,
            state: { kind: 'symlink', target: fs.readlinkSync(absolute) },
          });
        } else if (entryStat.isFile()) {
          entries.push({
            relativePath,
            state: { kind: 'file', content: fs.readFileSync(absolute) },
          });
        }
      }
    };
    walk(target, '');
    return { kind: 'directory', entries };
  }

  private restore(target: string, state: SnapshotState): void {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    if (state.kind === 'missing') return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (state.kind === 'file') {
      fs.writeFileSync(target, state.content);
      return;
    }
    if (state.kind === 'symlink') {
      fs.symlinkSync(state.target, target);
      return;
    }

    fs.mkdirSync(target, { recursive: true });
    for (const entry of state.entries) {
      const destination = path.join(target, entry.relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (entry.state.kind === 'directory') fs.mkdirSync(destination, { recursive: true });
      else if (entry.state.kind === 'symlink') fs.symlinkSync(entry.state.target, destination);
      else fs.writeFileSync(destination, entry.state.content);
    }
  }
}
