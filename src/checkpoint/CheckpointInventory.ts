import * as fs from 'fs';
import * as path from 'path';
import { fromManifestPath, toManifestPath } from './CheckpointManifest';

const EXCLUDED_TOP_LEVEL = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv']);

export interface InventoryFileEntry {
  kind: 'file';
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

export interface InventoryDirectoryEntry {
  kind: 'directory';
  relativePath: string;
  absolutePath: string;
  mode: number;
}

export interface InventorySymlinkEntry {
  kind: 'symlink';
  relativePath: string;
  absolutePath: string;
  target: string;
  linkType: 'file' | 'dir' | 'junction';
}

export type InventoryEntry = InventoryFileEntry | InventoryDirectoryEntry | InventorySymlinkEntry;

export type CheckpointCoverage = { kind: 'workspace' } | { kind: 'paths'; relativePaths: string[] };

export interface CheckpointInventory {
  workspaceRoot: string;
  coverage: CheckpointCoverage;
  entries: InventoryEntry[];
  fileCount: number;
  totalBytes: number;
}

export interface InventoryProgress {
  phase: 'inventory' | 'finalize';
  fileCount: number;
  totalBytes: number;
}

export function isExcludedTopLevel(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.forge' || lower.startsWith('.forge-') || EXCLUDED_TOP_LEVEL.has(lower);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Checkpoint preparation cancelled');
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function coverageForPaths(
  workspaceRoot: string,
  targets: readonly string[],
): CheckpointCoverage {
  const root = path.resolve(workspaceRoot);
  const relativePaths = targets.map((target) => {
    const absolute = path.resolve(target);
    if (!isInsideRoot(root, absolute))
      throw new Error(`Checkpoint path escapes workspace: ${target}`);
    const relative = path.relative(root, absolute);
    if (!relative) return '';
    const manifestPath = toManifestPath(relative);
    fromManifestPath(manifestPath);
    return manifestPath;
  });
  if (relativePaths.includes('')) return { kind: 'workspace' };

  const selected: string[] = [];
  for (const candidate of [...new Set(relativePaths)].sort((a, b) => a.length - b.length)) {
    const topLevel = candidate.split('/')[0];
    if (!topLevel || isExcludedTopLevel(topLevel)) {
      throw new Error(`Forge checkpoint excludes protected path: ${candidate}`);
    }
    if (!selected.some((parent) => candidate === parent || candidate.startsWith(`${parent}/`))) {
      selected.push(candidate);
    }
  }
  return { kind: 'paths', relativePaths: selected };
}

async function walkTarget(
  root: string,
  absolute: string,
  entries: Map<string, InventoryEntry>,
  signal: AbortSignal,
  onProgress: ((progress: InventoryProgress) => void) | undefined,
  phase: InventoryProgress['phase'],
  totals: { fileCount: number; totalBytes: number },
): Promise<void> {
  throwIfAborted(signal);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const relativePath = toManifestPath(path.relative(root, absolute));
  if (!relativePath)
    throw new Error('Checkpoint inventory cannot capture the workspace root entry');
  fromManifestPath(relativePath);

  if (stat.isSymbolicLink()) {
    let targetIsDirectory = false;
    try {
      targetIsDirectory = (await fs.promises.stat(absolute)).isDirectory();
    } catch {
      // Broken links are restored as file links because their target type is unknowable.
    }
    entries.set(relativePath, {
      kind: 'symlink',
      relativePath,
      absolutePath: absolute,
      target: await fs.promises.readlink(absolute),
      linkType: targetIsDirectory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file',
    });
    return;
  }
  if (stat.isFile()) {
    entries.set(relativePath, {
      kind: 'file',
      relativePath,
      absolutePath: absolute,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
    });
    totals.fileCount += 1;
    totals.totalBytes += stat.size;
    onProgress?.({ phase, ...totals });
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Checkpoint does not support path type: ${absolute}`);

  entries.set(relativePath, {
    kind: 'directory',
    relativePath,
    absolutePath: absolute,
    mode: stat.mode,
  });
  const names = await fs.promises.readdir(absolute);
  for (const name of names) {
    await walkTarget(root, path.join(absolute, name), entries, signal, onProgress, phase, totals);
  }
}

export async function inventoryCheckpointCoverage(
  workspaceRoot: string,
  coverage: CheckpointCoverage,
  signal: AbortSignal,
  phase: InventoryProgress['phase'],
  onProgress?: (progress: InventoryProgress) => void,
): Promise<CheckpointInventory> {
  const root = path.resolve(workspaceRoot);
  const rootStat = await fs.promises.stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Forge: workspace root is not a directory: ${root}`);
  const entries = new Map<string, InventoryEntry>();
  const totals = { fileCount: 0, totalBytes: 0 };

  const targets =
    coverage.kind === 'workspace'
      ? (await fs.promises.readdir(root)).filter((name) => !isExcludedTopLevel(name))
      : coverage.relativePaths.map(fromManifestPath);
  for (const target of targets) {
    await walkTarget(root, path.join(root, target), entries, signal, onProgress, phase, totals);
  }

  return {
    workspaceRoot: root,
    coverage,
    entries: [...entries.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    ...totals,
  };
}
