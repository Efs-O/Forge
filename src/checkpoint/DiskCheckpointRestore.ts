import * as fs from 'fs';
import * as path from 'path';
import { hashCheckpointFile } from './CheckpointFileIO';
import { isPathInside } from '../util/pathContainment';
import {
  type DiskCheckpointReference,
  fromManifestPath,
  parseCommittedManifest,
} from './CheckpointManifest';

function resolveWorkspaceTarget(root: string, relativePath: string): string {
  const target = path.resolve(root, fromManifestPath(relativePath));
  if (target === root || !isPathInside(root, target)) {
    throw new Error('Checkpoint target escapes workspace');
  }
  return target;
}

async function removeCheckpointTarget(target: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink()) await fs.promises.unlink(target);
  else await fs.promises.rm(target, { recursive: true, force: true });
}

async function isExistingDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function restoreDiskCheckpoint(reference: DiskCheckpointReference): Promise<string[]> {
  const manifest = parseCommittedManifest(
    await fs.promises.readFile(reference.manifestPath, 'utf8'),
  );
  const root = path.resolve(reference.workspaceRoot);
  if (path.resolve(manifest.workspaceRoot) !== root)
    throw new Error('Checkpoint workspace mismatch');
  for (const relativePath of [...manifest.createdPaths].sort((a, b) => b.length - a.length)) {
    await removeCheckpointTarget(resolveWorkspaceTarget(root, relativePath));
  }
  const directories = manifest.originalEntries
    .filter((entry) => entry.kind === 'directory')
    .sort((a, b) => a.relativePath.length - b.relativePath.length);
  for (const entry of directories) {
    const target = resolveWorkspaceTarget(root, entry.relativePath);
    if (!(await isExistingDirectory(target))) await removeCheckpointTarget(target);
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.chmod(target, entry.mode);
  }
  for (const entry of manifest.originalEntries.filter(
    (candidate) => candidate.kind !== 'directory',
  )) {
    const target = resolveWorkspaceTarget(root, entry.relativePath);
    await removeCheckpointTarget(target);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    if (entry.kind === 'symlink') {
      await fs.promises.symlink(entry.target, target, entry.linkType);
      continue;
    }
    const blob = path.resolve(reference.checkpointDir, fromManifestPath(entry.blobPath));
    if (!isPathInside(reference.checkpointDir, blob))
      throw new Error('Checkpoint blob escapes storage');
    const stat = await fs.promises.stat(blob);
    if (stat.size !== entry.size)
      throw new Error(`Checkpoint blob size mismatch: ${entry.relativePath}`);
    if ((await hashCheckpointFile(blob)) !== entry.sha256) {
      throw new Error(`Checkpoint blob hash mismatch: ${entry.relativePath}`);
    }
    await fs.promises.copyFile(blob, target);
    await fs.promises.chmod(target, entry.mode);
  }
  return [...reference.changedPaths];
}

export async function discardDiskCheckpoint(reference: DiskCheckpointReference): Promise<void> {
  await fs.promises.rm(reference.checkpointDir, { recursive: true, force: true });
}
