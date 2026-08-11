import * as fs from 'fs';
import * as path from 'path';

export type MemoryLeafState =
  | { kind: 'file'; content: Buffer }
  | { kind: 'directory' }
  | { kind: 'symlink'; target: string };

export interface MemoryDirectoryEntry {
  relativePath: string;
  state: MemoryLeafState;
}

export type MemorySnapshotState =
  | { kind: 'missing' }
  | { kind: 'file'; content: Buffer }
  | { kind: 'directory'; entries: MemoryDirectoryEntry[] }
  | { kind: 'symlink'; target: string };

export function captureMemoryState(target: string): MemorySnapshotState {
  if (!fs.existsSync(target)) return { kind: 'missing' };
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(target) };
  if (stat.isFile()) return { kind: 'file', content: fs.readFileSync(target) };
  if (!stat.isDirectory()) throw new Error(`CheckpointStack: unsupported path type ${target}`);

  const entries: MemoryDirectoryEntry[] = [];
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

export function restoreMemoryState(target: string, state: MemorySnapshotState): void {
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
