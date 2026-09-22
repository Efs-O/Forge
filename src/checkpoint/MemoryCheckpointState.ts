import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { assertCheckpointWithinLimits, type CheckpointLimits } from './CheckpointPolicy';
import { writeFileAtomicSync } from '../util/atomicWrite';

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

export function captureMemoryState(target: string, limits?: CheckpointLimits): MemorySnapshotState {
  if (!fs.existsSync(target)) return { kind: 'missing' };
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(target) };
  if (stat.isFile()) {
    if (limits) assertCheckpointWithinLimits({ totalBytes: stat.size, fileCount: 1 }, limits);
    return { kind: 'file', content: fs.readFileSync(target) };
  }
  if (!stat.isDirectory()) throw new Error(`CheckpointStack: unsupported path type ${target}`);

  const entries: MemoryDirectoryEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  const assertWithinLimits = (): void => {
    if (limits) assertCheckpointWithinLimits({ totalBytes, fileCount }, limits);
  };
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
        totalBytes += entryStat.size;
        fileCount += 1;
        assertWithinLimits();
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

/** Stable content/type fingerprint used to reject stale destructive restores. */
export function fingerprintMemoryState(target: string): string {
  const hash = createHash('sha256');
  const visit = (absolute: string, relative: string): void => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        hash.update(`missing:${relative}\0`);
        return;
      }
      throw error;
    }
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      hash.update(`symlink:${relative}:${mode}:${fs.readlinkSync(absolute)}\0`);
      return;
    }
    if (stat.isFile()) {
      hash.update(`file:${relative}:${mode}:`);
      hash.update(fs.readFileSync(absolute));
      hash.update('\0');
      return;
    }
    if (!stat.isDirectory()) throw new Error(`CheckpointStack: unsupported path type ${absolute}`);
    hash.update(`directory:${relative}:${mode}\0`);
    for (const name of fs.readdirSync(absolute).sort()) {
      visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
    }
  };
  visit(path.resolve(target), '');
  return hash.digest('hex');
}

export function restoreMemoryState(target: string, state: MemorySnapshotState): void {
  if (state.kind === 'missing') {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (state.kind === 'file') {
    writeFileAtomicSync(target, state.content);
    return;
  }
  if (state.kind === 'symlink') {
    const stagingLink = path.join(
      path.dirname(target),
      `.${path.basename(target)}.forge-link-${process.pid}-${Date.now()}`,
    );
    try {
      fs.symlinkSync(state.target, stagingLink);
      fs.renameSync(stagingLink, target);
    } catch (error) {
      if (fs.existsSync(stagingLink)) fs.rmSync(stagingLink, { force: true });
      throw error;
    }
    return;
  }

  const staging = path.join(
    path.dirname(target),
    `.${path.basename(target)}.forge-restore-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const entry of state.entries) {
      const destination = path.join(staging, entry.relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (entry.state.kind === 'directory') fs.mkdirSync(destination, { recursive: true });
      else if (entry.state.kind === 'symlink') fs.symlinkSync(entry.state.target, destination);
      else writeFileAtomicSync(destination, entry.state.content);
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  const backup = `${staging}.previous`;
  const hadTarget = fs.existsSync(target);
  try {
    if (hadTarget) fs.renameSync(target, backup);
    fs.renameSync(staging, target);
  } catch (error) {
    try {
      if (hadTarget && fs.existsSync(backup) && !fs.existsSync(target))
        fs.renameSync(backup, target);
    } finally {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
  if (hadTarget) fs.rmSync(backup, { recursive: true, force: true });
}
