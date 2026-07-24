import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface GgufCandidate {
  ggufPath: string;
  modelName: string; // derived from filename
  sizeBytes: number;
  familyHint: string; // 'qwen3' | 'gemma4' | 'llama' | 'mistral' | 'phi' | 'unknown'
  /** Quant token parsed from the filename (e.g. `Q4_K_M`, `IQ3_S`), if recognizable. */
  quant?: string;
  /** Sibling `mmproj-*.gguf` found in the same directory, auto-suggested as `mmproj_path`. */
  mmprojPath?: string;
}

const QUANT_RE = /\b(IQ[1-4]_[A-Z0-9_]+|Q[2-8]_[A-Z0-9_]+|F16|BF16|F32)\b/i;

/** Extract a recognizable quant token from a GGUF filename (F7/§2.5). Returns
 *  undefined for names that don't match a known quant naming convention. */
export function extractQuant(filename: string): string | undefined {
  const m = QUANT_RE.exec(filename);
  return m ? m[1].toUpperCase() : undefined;
}

/** True for `mmproj-*.gguf` / `*-mmproj.gguf` vision-projector files — these
 *  are never model candidates themselves, only sibling attachments (F7/§2.5). */
export function isMmprojFile(filename: string): boolean {
  return filename.toLowerCase().includes('mmproj');
}

const MAX_DEPTH = 5;
const MAX_RESULTS = 50;
// Overall wall-clock budget for a full scan. Past this we return whatever was
// found so far rather than blocking the first-run wizard indefinitely.
const SCAN_DEADLINE_MS = 8000;
// Per-drive existence probe cap. A disconnected / slow mapped network drive can
// otherwise stall fs access for tens of seconds; we bound each probe and run
// them in parallel so 26 drive letters cost ~1s total, not 26 × network timeout.
const DRIVE_PROBE_TIMEOUT_MS = 1000;

function deriveFamily(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('qwen3') || lower.includes('qwen3.')) return 'qwen3';
  if (lower.includes('gemma-4') || lower.includes('gemma4')) return 'gemma4';
  if (lower.includes('llama-3') || lower.includes('llama3')) return 'llama';
  if (lower.includes('mistral')) return 'mistral';
  if (
    lower.includes('phi-3') ||
    lower.includes('phi-4') ||
    lower.includes('phi3') ||
    lower.includes('phi4')
  )
    return 'phi';
  return 'unknown';
}

function deriveModelName(filePath: string): string {
  const base = path.basename(filePath, '.gguf');
  return base
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .toLowerCase()
    .slice(0, 40);
}

/** Resolve true if `target` exists within `timeoutMs`, false otherwise (never throws, never hangs). */
async function pathExistsWithin(target: string, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const probe = fsp.access(target).then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function scanDirectory(
  rootDir: string,
  results: Map<string, GgufCandidate>,
  visitedDirs: Set<string>,
  deadline: number,
  mmprojByDir: Map<string, string[]>,
): Promise<void> {
  const pending: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (pending.length > 0) {
    if (results.size >= MAX_RESULTS || Date.now() > deadline) return;

    const next = pending.pop();
    if (!next) continue;
    const { dir, depth } = next;
    if (depth > MAX_DEPTH) continue;

    let normalizedDir: string;
    try {
      normalizedDir = await fsp.realpath(dir);
    } catch {
      normalizedDir = path.resolve(dir);
    }
    if (visitedDirs.has(normalizedDir)) continue;
    visitedDirs.add(normalizedDir);

    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // permission denied or other error: skip this directory only
    }

    for (const entry of entries) {
      if (results.size >= MAX_RESULTS) break;

      const fullPath = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        pending.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.gguf')) continue;

      const resolved = path.resolve(fullPath);

      // mmproj files are never model candidates — collect them per-directory
      // so a later pass can attach the sibling to any model found alongside it.
      if (isMmprojFile(entry.name)) {
        const list = mmprojByDir.get(dir) ?? [];
        list.push(resolved);
        mmprojByDir.set(dir, list);
        continue;
      }

      if (results.has(resolved)) continue;

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(resolved);
      } catch {
        continue;
      }

      const quant = extractQuant(entry.name);
      results.set(resolved, {
        ggufPath: resolved,
        modelName: deriveModelName(resolved),
        sizeBytes: stat.size,
        familyHint: deriveFamily(entry.name),
        ...(quant !== undefined ? { quant } : {}),
      });
    }
  }
}

async function defaultScanDirs(): Promise<string[]> {
  const home = os.homedir();
  const hfRelative = path.join('.cache', 'huggingface', 'hub');
  const dirs: string[] = [path.join(home, hfRelative)];

  if (process.platform === 'win32') {
    // Check HF cache on all mounted drive letters (covers external / NAS drives).
    // Probes run in parallel and each is time-bounded so a dead/slow mapped
    // network drive cannot stall the scan.
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const probes = await Promise.all(
      letters.map(async (letter) => {
        const candidate = `${letter}:\\${hfRelative}`;
        if (candidate === dirs[0]) return null;
        return (await pathExistsWithin(candidate, DRIVE_PROBE_TIMEOUT_MS)) ? candidate : null;
      }),
    );
    for (const candidate of probes) {
      if (candidate) dirs.push(candidate);
    }
  }

  return dirs;
}

/**
 * Scan model directories for .gguf files.
 * Directories searched in order:
 * 1. User-configured model_dirs from config (extraDirs)
 * 2. Default HF cache on home drive
 * 3. (Windows) HF cache on all other mounted drives
 *
 * Bounded by depth (MAX_DEPTH), result count (MAX_RESULTS) and an overall
 * wall-clock deadline (SCAN_DEADLINE_MS); all filesystem access is async so the
 * extension host is never blocked.
 */
export async function scanForGgufs(extraDirs: string[] = []): Promise<GgufCandidate[]> {
  const deadline = Date.now() + SCAN_DEADLINE_MS;
  const dirsToSearch = [...extraDirs, ...(await defaultScanDirs())];

  const results = new Map<string, GgufCandidate>();
  const visitedDirs = new Set<string>();
  const mmprojByDir = new Map<string, string[]>();

  for (const dir of dirsToSearch) {
    if (results.size >= MAX_RESULTS || Date.now() > deadline) break;

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(dir);
    } catch {
      continue; // missing or inaccessible
    }
    if (!stat.isDirectory()) continue;

    await scanDirectory(dir, results, visitedDirs, deadline, mmprojByDir);
  }

  // Attach the first sibling mmproj file found in the same directory (F7/§2.5).
  for (const candidate of results.values()) {
    const dir = path.dirname(candidate.ggufPath);
    const siblings = mmprojByDir.get(dir);
    if (siblings?.[0]) candidate.mmprojPath = siblings[0];
  }

  return Array.from(results.values()).sort((a, b) => {
    if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
    return a.ggufPath.localeCompare(b.ggufPath, undefined, { sensitivity: 'base' });
  });
}
