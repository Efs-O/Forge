import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readClaudeUsage, readCodexUsage, type UsageEvidence } from './usage';

export interface CapturedUsage {
  status: 'available' | 'unavailable';
  provider: 'claude' | 'codex' | 'qwen';
  evidence?:
    | UsageEvidence
    | { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  transcript_path?: string;
  reason?: string;
}

function tailLines(filePath: string): string[] {
  const stat = fs.statSync(filePath);
  const bytes = Math.min(stat.size, 256_000);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, stat.size - bytes);
    return buffer.toString('utf8').split(/\r?\n/u);
  } finally {
    fs.closeSync(fd);
  }
}

function findFiles(root: string, predicate: (file: string, stat: fs.Stats) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const visit = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          if (predicate(full, stat)) result.push(full);
        } catch {
          /* A CLI may rotate/delete a transcript while we inspect it. */
        }
      }
    }
  };
  visit(root);
  return result;
}

function fresh(files: string[], startedAt: number): string[] {
  return files
    .filter((file) => {
      try {
        return fs.statSync(file).mtimeMs >= startedAt - 60_000;
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

export function captureCliUsage(
  provider: 'claude' | 'codex',
  sessionId: string | undefined,
  startedAt: number,
): CapturedUsage {
  if (!sessionId)
    return { status: 'unavailable', provider, reason: 'CLI did not report a session identifier.' };
  const home = os.homedir();
  const root =
    provider === 'claude'
      ? path.join(home, '.claude', 'projects')
      : path.join(home, '.codex', 'sessions');
  const files = fresh(
    findFiles(root, (file) => file.endsWith('.jsonl')),
    startedAt,
  );
  const exact = files.filter(
    (file) => path.basename(file, '.jsonl') === sessionId || file.includes(sessionId),
  );
  const candidates = exact.length ? exact : files.slice(0, 10);
  for (const file of candidates) {
    let lines: string[];
    try {
      lines = tailLines(file);
    } catch {
      continue;
    }
    if (!exact.length && !lines.some((line) => line.includes(sessionId))) continue;
    const evidence = provider === 'claude' ? readClaudeUsage(lines) : readCodexUsage(lines);
    if (evidence) return { status: 'available', provider, evidence, transcript_path: file };
  }
  return {
    status: 'unavailable',
    provider,
    reason: `No fresh ${provider} transcript with recognised usage was found.`,
  };
}

export function qwenUsage(
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined,
): CapturedUsage {
  return usage
    ? { status: 'available', provider: 'qwen', evidence: usage }
    : {
        status: 'unavailable',
        provider: 'qwen',
        reason: 'llama-server did not return stream usage.',
      };
}
