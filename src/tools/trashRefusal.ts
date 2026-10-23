import * as fs from 'fs';
import * as path from 'path';

const TRASH_REFUSAL_TTL_MS = 60 * 60_000;
const TRASH_REFUSAL_LIMIT = 100;
const DEFAULT_ENTRY_LIMIT = 20_000;
const DEFAULT_TIME_LIMIT_MS = 5_000;
const LONG_PATH_LIMIT = 260;

interface CachedRefusal {
  diagnosis: string;
  expiresAt: number;
}

export interface TrashRefusalScanOptions {
  /** Narrower limits are useful for deterministic cap tests. Production uses the defaults. */
  entryLimit?: number;
  timeLimitMs?: number;
  now?: () => number;
  readDirectory?: (directory: string) => fs.Dirent[];
}

const refusals = new Map<string, CachedRefusal>();

function cacheKey(targetPath: string): string {
  let resolved = path.resolve(targetPath);
  if (process.platform !== 'win32') return resolved;
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  if (resolved.startsWith('\\\\?\\UNC\\')) resolved = `\\\\${resolved.slice(8)}`;
  else if (resolved.startsWith('\\\\?\\')) resolved = resolved.slice(4);
  return resolved.toLowerCase();
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').trim();
}

function isUncPath(targetPath: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/u.test(targetPath);
}

function extendedPath(targetPath: string): string {
  if (process.platform !== 'win32' || targetPath.startsWith('\\\\?\\')) return targetPath;
  if (targetPath.startsWith('\\\\')) return `\\\\?\\UNC\\${targetPath.slice(2)}`;
  return `\\\\?\\${targetPath}`;
}

/**
 * Inspect a refused recycle-bin target and return only facts Forge can check.
 * This runs only on the failure path; successful trash moves never walk the tree.
 */
export function diagnoseTrashRefusal(
  targetPath: string,
  options: TrashRefusalScanOptions = {},
): string {
  const entryLimit = options.entryLimit ?? DEFAULT_ENTRY_LIMIT;
  const timeLimitMs = options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
  const now = options.now ?? Date.now;
  const readDirectory =
    options.readDirectory ??
    ((directory: string) => fs.readdirSync(extendedPath(directory), { withFileTypes: true }));
  const startedAt = now();
  const root = path.resolve(targetPath);
  const pending = [root];
  const scanErrors: string[] = [];
  let scanErrorCount = 0;
  let entriesSeen = 0;
  let longPathCount = 0;
  let longestLength = 0;
  let longestPath = root;
  let entryCapped = false;
  let timeCapped = false;

  const consider = (absolutePath: string): void => {
    if (absolutePath.length < LONG_PATH_LIMIT) return;
    longPathCount++;
    if (absolutePath.length > longestLength) {
      longestLength = absolutePath.length;
      longestPath = absolutePath;
    }
  };

  consider(root);
  while (pending.length > 0) {
    if (now() - startedAt >= timeLimitMs) {
      timeCapped = true;
      break;
    }
    const directory = pending.pop();
    if (!directory) break;
    let entries: fs.Dirent[];
    try {
      entries = readDirectory(directory);
    } catch (error) {
      scanErrorCount++;
      if (scanErrors.length < 3)
        scanErrors.push(`${path.relative(root, directory) || '.'}: ${oneLine(String(error))}`);
      continue;
    }
    for (const entry of entries) {
      if (entriesSeen >= entryLimit) {
        entryCapped = true;
        break;
      }
      entriesSeen++;
      const absolutePath = path.join(directory, entry.name);
      consider(absolutePath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(absolutePath);
      if (now() - startedAt >= timeLimitMs) {
        timeCapped = true;
        break;
      }
    }
    if (entryCapped || timeCapped) break;
  }

  const diagnosis: string[] = [];
  if (longPathCount > 0) {
    const relativeLongest = oneLine(path.relative(root, longestPath) || path.basename(root));
    diagnosis.push(
      `Found ${longPathCount.toLocaleString()} paths of 260+ characters ` +
        `(longest ${longestLength}: ${relativeLongest}); the Windows recycle bin cannot hold them.`,
    );
  } else {
    diagnosis.push(
      'Cause unknown. Common causes include a file open in another program or an item larger ' +
        "than the recycle bin's size limit.",
    );
  }
  if (isUncPath(targetPath)) {
    diagnosis.push('This is a UNC network/WSL path, where recycle-bin moves may not be supported.');
  }
  if (entryCapped) diagnosis.push(`Checked the first ${entryLimit.toLocaleString()} entries.`);
  if (timeCapped) {
    const duration =
      timeLimitMs % 1000 === 0 ? `${timeLimitMs / 1000} seconds` : `${timeLimitMs} ms`;
    diagnosis.push(`Stopped after ${duration}.`);
  }
  if (scanErrorCount > 0) {
    const extra = scanErrorCount > scanErrors.length ? ` (first ${scanErrors.length} shown)` : '';
    diagnosis.push(
      `Could not inspect ${scanErrorCount} path(s)${extra}: ${scanErrors.join('; ')}.`,
    );
  }
  return diagnosis.join(' ');
}

/** Remember the last recycle-bin refusal for the permanent-delete approval preview. */
export function rememberTrashRefusal(targetPath: string, diagnosis: string): void {
  const key = cacheKey(targetPath);
  refusals.delete(key);
  while (refusals.size >= TRASH_REFUSAL_LIMIT) {
    const oldest = refusals.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    refusals.delete(oldest);
  }
  refusals.set(key, { diagnosis, expiresAt: Date.now() + TRASH_REFUSAL_TTL_MS });
}

/** Return an unexpired diagnosis for an approval preview, pruning expired entries. */
export function trashRefusalForPath(targetPath: string): string | undefined {
  const now = Date.now();
  for (const [key, refusal] of refusals) {
    if (refusal.expiresAt <= now) refusals.delete(key);
  }
  return refusals.get(cacheKey(targetPath))?.diagnosis;
}

/** A successful delete of this path makes its old refusal irrelevant. */
export function forgetTrashRefusal(targetPath: string): void {
  refusals.delete(cacheKey(targetPath));
}

/** Drop process-local diagnoses when the owning extension service is disposed. */
export function clearTrashRefusals(): void {
  refusals.clear();
}
