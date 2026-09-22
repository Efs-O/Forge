import * as fs from 'fs';
import * as path from 'path';
import { hashCheckpointFile } from './CheckpointFileIO';
import { isPathInside } from '../util/pathContainment';
import {
  type CommittedCheckpointManifest,
  type DiskCheckpointReference,
  fromManifestPath,
  parseCommittedManifest,
} from './CheckpointManifest';
import { fingerprintMemoryState } from './MemoryCheckpointState';

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

interface StagedCheckpointBlobs {
  directory: string;
  byPath: Map<string, string>;
}

async function stageCheckpointBlobs(
  reference: DiskCheckpointReference,
  root: string,
  entries: CommittedCheckpointManifest['originalEntries'],
): Promise<StagedCheckpointBlobs> {
  const directory = await fs.promises.mkdtemp(
    path.join(path.dirname(root), `.${path.basename(root)}.forge-restore-`),
  );
  const byPath = new Map<string, string>();
  try {
    let index = 0;
    for (const entry of entries.filter((candidate) => candidate.kind === 'file')) {
      const blob = path.resolve(reference.checkpointDir, fromManifestPath(entry.blobPath));
      if (!isPathInside(reference.checkpointDir, blob))
        throw new Error('Checkpoint blob escapes storage');
      const stat = await fs.promises.stat(blob);
      if (stat.size !== entry.size)
        throw new Error(`Checkpoint blob size mismatch: ${entry.relativePath}`);
      if ((await hashCheckpointFile(blob)) !== entry.sha256) {
        throw new Error(`Checkpoint blob hash mismatch: ${entry.relativePath}`);
      }

      const stagedBlob = path.join(directory, `${index++}.bin`);
      await fs.promises.copyFile(blob, stagedBlob);
      const stagedStat = await fs.promises.stat(stagedBlob);
      if (
        stagedStat.size !== entry.size ||
        (await hashCheckpointFile(stagedBlob)) !== entry.sha256
      ) {
        throw new Error(`Checkpoint staging verification failed: ${entry.relativePath}`);
      }
      byPath.set(entry.relativePath, stagedBlob);
    }
    return { directory, byPath };
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreDiskCheckpoint(reference: DiskCheckpointReference): Promise<string[]> {
  const manifest = parseCommittedManifest(
    await fs.promises.readFile(reference.manifestPath, 'utf8'),
  );
  const root = path.resolve(reference.workspaceRoot);
  await assertDiskCheckpointCurrent(reference, manifest);
  if (path.resolve(manifest.workspaceRoot) !== root)
    throw new Error('Checkpoint workspace mismatch');
  const staged = await stageCheckpointBlobs(reference, root, manifest.originalEntries);
  try {
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
      await fs.promises.copyFile(staged.byPath.get(entry.relativePath)!, target);
      await fs.promises.chmod(target, entry.mode);
    }
  } finally {
    await fs.promises.rm(staged.directory, { recursive: true, force: true });
  }
  return [...reference.changedPaths];
}

export async function assertDiskCheckpointCurrent(
  reference: DiskCheckpointReference,
  parsedManifest?: ReturnType<typeof parseCommittedManifest>,
): Promise<void> {
  const manifest =
    parsedManifest ??
    parseCommittedManifest(await fs.promises.readFile(reference.manifestPath, 'utf8'));
  if (!manifest.postconditions) {
    throw new Error('Checkpoint has no conflict metadata; Undo refused for safety.');
  }
  const root = path.resolve(reference.workspaceRoot);
  if (path.resolve(manifest.workspaceRoot) !== root)
    throw new Error('Checkpoint workspace mismatch');
  for (const postcondition of manifest.postconditions) {
    const target = resolveWorkspaceTarget(root, postcondition.relativePath);
    if (fingerprintMemoryState(target) !== postcondition.fingerprint) {
      throw new Error(
        `Workspace changed after checkpoint ${manifest.turnId}: ${postcondition.relativePath}. Undo refused.`,
      );
    }
  }
}

export async function discardDiskCheckpoint(reference: DiskCheckpointReference): Promise<void> {
  await fs.promises.rm(reference.checkpointDir, { recursive: true, force: true });
}
