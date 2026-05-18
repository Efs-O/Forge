import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface GgufCandidate {
  ggufPath: string;
  modelName: string;  // derived from filename
  sizeBytes: number;
  familyHint: string; // 'qwen3' | 'gemma4' | 'llama' | 'mistral' | 'phi' | 'unknown'
}

const MAX_DEPTH = 5;
const MAX_RESULTS = 50;

function deriveFamily(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('qwen3') || lower.includes('qwen3.')) return 'qwen3';
  if (lower.includes('gemma-4') || lower.includes('gemma4')) return 'gemma4';
  if (lower.includes('llama-3') || lower.includes('llama3')) return 'llama';
  if (lower.includes('mistral')) return 'mistral';
  if (lower.includes('phi-3') || lower.includes('phi-4') || lower.includes('phi3') || lower.includes('phi4')) return 'phi';
  return 'unknown';
}

function deriveModelName(filePath: string): string {
  const base = path.basename(filePath, '.gguf');
  return base.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase().slice(0, 40);
}

function walkDir(dir: string, depth: number, results: Map<string, GgufCandidate>): void {
  if (depth > MAX_DEPTH || results.size >= MAX_RESULTS) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permission denied or other error — skip silently
  }

  for (const entry of entries) {
    if (results.size >= MAX_RESULTS) break;

    const fullPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      walkDir(fullPath, depth + 1, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
      const resolved = path.resolve(fullPath);
      if (results.has(resolved)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        continue;
      }

      results.set(resolved, {
        ggufPath: resolved,
        modelName: deriveModelName(resolved),
        sizeBytes: stat.size,
        familyHint: deriveFamily(entry.name),
      });
    }
  }
}

function defaultScanDirs(): string[] {
  const home = os.homedir();
  const hfRelative = path.join('.cache', 'huggingface', 'hub');
  const dirs: string[] = [path.join(home, hfRelative)];

  if (process.platform === 'win32') {
    // Check HF cache on all mounted drive letters (covers external / NAS drives)
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (const letter of letters) {
      const candidate = `${letter}:\\${hfRelative}`;
      if (candidate !== dirs[0] && fs.existsSync(candidate)) {
        dirs.push(candidate);
      }
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
 */
export async function scanForGgufs(extraDirs: string[] = []): Promise<GgufCandidate[]> {
  const dirsToSearch = [...extraDirs, ...defaultScanDirs()];

  const results = new Map<string, GgufCandidate>();

  for (const dir of dirsToSearch) {
    if (!fs.existsSync(dir)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    walkDir(dir, 0, results);
    if (results.size >= MAX_RESULTS) break;
  }

  return Array.from(results.values())
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, MAX_RESULTS);
}
