import type { CheckpointInventory, InventoryEntry } from './CheckpointInventory';
import type { StoredCheckpointEntry } from './CheckpointManifest';

export function checkpointEntryChanged(
  original: StoredCheckpointEntry,
  current: InventoryEntry | undefined,
  currentHash: string | undefined,
): boolean {
  if (!current || current.kind !== original.kind) return true;
  if (original.kind === 'file' && current.kind === 'file') {
    return original.sha256 !== currentHash || original.mode !== current.mode;
  }
  if (original.kind === 'directory' && current.kind === 'directory') {
    return original.mode !== current.mode;
  }
  return original.kind === 'symlink' && current.kind === 'symlink'
    ? original.target !== current.target || original.linkType !== current.linkType
    : true;
}

export function minimalCreatedCheckpointPaths(paths: string[]): string[] {
  const selected: string[] = [];
  for (const candidate of paths.sort((a, b) => a.length - b.length)) {
    if (!selected.some((parent) => candidate === parent || candidate.startsWith(`${parent}/`))) {
      selected.push(candidate);
    }
  }
  return selected;
}

export function checkpointInventoriesMatch(
  expected: CheckpointInventory,
  actual: CheckpointInventory,
): boolean {
  if (
    expected.fileCount !== actual.fileCount ||
    expected.totalBytes !== actual.totalBytes ||
    expected.entries.length !== actual.entries.length
  ) {
    return false;
  }
  const actualByPath = new Map(actual.entries.map((entry) => [entry.relativePath, entry]));
  return expected.entries.every((entry) => {
    const candidate = actualByPath.get(entry.relativePath);
    if (!candidate || candidate.kind !== entry.kind) return false;
    if (entry.kind === 'file' && candidate.kind === 'file') {
      return (
        entry.size === candidate.size &&
        entry.mtimeMs === candidate.mtimeMs &&
        entry.mode === candidate.mode
      );
    }
    if (entry.kind === 'directory' && candidate.kind === 'directory') {
      return entry.mode === candidate.mode;
    }
    return entry.kind === 'symlink' && candidate.kind === 'symlink'
      ? entry.target === candidate.target && entry.linkType === candidate.linkType
      : false;
  });
}
