import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { isFailureResult } from '../sidebar/toolResultView';
import { readSessionLogRows } from '../sessions/sessionLogRows';

export const controlStatsSchema = z.object({
  forge_version: z.string(),
  day: z.string(),
  today: z.object({
    turns: z.number(),
    requests: z.number(),
    compactions: z.number(),
    compaction_attempts_failed: z.number(),
    compactions_suppressed: z.number(),
    tool_calls: z.number(),
    tool_failures: z.number(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    turn_errors: z.number(),
  }),
  last_request: z
    .object({
      model: z.string(),
      input_tokens: z.number(),
      context_limit: z.number().nullable(),
      at: z.number(),
    })
    .nullable(),
  computed_at: z.number(),
  skipped_files: z.number(),
});

export type ControlStats = z.infer<typeof controlStatsSchema>;

interface FileCacheEntry {
  size: number;
  mtimeMs: number;
  rows: Array<Record<string, unknown>>;
}

export interface ControlStatsOptions {
  sessionsDir: string;
  now: () => number;
  contextLimitFor: (model: string) => number | null;
  forgeVersion: string;
}

function localDay(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Builds a counts-only summary; persisted row text is never copied to the reply. */
export class ControlStatsBuilder {
  private readonly fileCache = new Map<string, FileCacheEntry>();
  private cachedReply: ControlStats | undefined;
  private cachedAtMs = 0;

  constructor(private readonly options: ControlStatsOptions) {}

  build(): ControlStats {
    const nowMs = this.options.now();
    const day = localDay(nowMs);
    if (
      this.cachedReply?.day === day &&
      nowMs >= this.cachedAtMs &&
      nowMs - this.cachedAtMs < 3_000
    ) {
      return this.cachedReply;
    }

    const files = this.filesForDay(day);
    const todayPaths = new Set(files.map((file) => file.path));
    for (const cachedPath of this.fileCache.keys()) {
      if (!todayPaths.has(cachedPath)) this.fileCache.delete(cachedPath);
    }

    const result: ControlStats = {
      forge_version: this.options.forgeVersion,
      day,
      today: {
        turns: 0,
        requests: 0,
        compactions: 0,
        compaction_attempts_failed: 0,
        compactions_suppressed: 0,
        tool_calls: 0,
        tool_failures: 0,
        input_tokens: 0,
        output_tokens: 0,
        turn_errors: 0,
      },
      last_request: null,
      computed_at: Math.floor(nowMs / 1_000),
      skipped_files: 0,
    };
    let lastRequestAtMs = -1;

    for (const file of files) {
      let rows: Array<Record<string, unknown>>;
      try {
        rows = this.rowsForFile(file.path, file.size, file.mtimeMs);
      } catch {
        result.skipped_files += 1;
        this.fileCache.delete(file.path);
        continue;
      }

      // SessionLogger owns flat *.jsonl names, but other producers may share
      // this directory. Requiring the logger's session_start marker excludes
      // files such as voice.jsonl without relying on a filename convention.
      if (!rows.some((row) => row['type'] === 'session_start')) continue;

      for (const row of rows) {
        const timestampMs = row['timestamp_ms'];
        if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) continue;
        if (localDay(timestampMs) !== day) continue;
        const type = row['type'];
        if (row['role'] === 'user') result.today.turns += 1;
        if (row['role'] === 'tool') {
          result.today.tool_calls += 1;
          if (typeof row['content'] === 'string' && isFailureResult(row['content'])) {
            result.today.tool_failures += 1;
          }
        }
        if (type === 'usage') {
          result.today.requests += 1;
          result.today.input_tokens += finiteNumber(row['input_tokens']);
          result.today.output_tokens += finiteNumber(row['output_tokens']);
          const model = typeof row['model'] === 'string' ? row['model'] : '';
          if (timestampMs > lastRequestAtMs) {
            lastRequestAtMs = timestampMs;
            result.last_request = {
              model,
              input_tokens: finiteNumber(row['input_tokens']),
              context_limit: model ? this.options.contextLimitFor(model) : null,
              at: Math.floor(timestampMs / 1_000),
            };
          }
        } else if (type === 'compaction') {
          result.today.compactions += 1;
        } else if (type === 'compaction_attempt') {
          if (row['phase'] === 'suppressed') result.today.compactions_suppressed += 1;
          else if (row['phase'] === 'finished' && row['outcome'] !== 'compacted') {
            result.today.compaction_attempts_failed += 1;
          }
        } else if (type === 'turn_error') {
          result.today.turn_errors += 1;
        }
      }
    }

    this.cachedAtMs = nowMs;
    this.cachedReply = controlStatsSchema.parse(result);
    return this.cachedReply;
  }

  private filesForDay(day: string): Array<{ path: string; size: number; mtimeMs: number }> {
    let names: string[];
    try {
      names = fs.readdirSync(this.options.sessionsDir);
    } catch {
      return [];
    }
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(this.options.sessionsDir, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || localDay(stat.mtimeMs) !== day) continue;
        files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // A disappearing or unreadable candidate is counted by the read path
        // only when it was successfully identified as today's file.
      }
    }
    return files;
  }

  private rowsForFile(
    filePath: string,
    size: number,
    mtimeMs: number,
  ): Array<Record<string, unknown>> {
    const cached = this.fileCache.get(filePath);
    if (cached?.size === size && cached.mtimeMs === mtimeMs) return cached.rows;
    const rows = readSessionLogRows(filePath);
    this.fileCache.set(filePath, { size, mtimeMs, rows });
    return rows;
  }
}

export function createControlStatsBuilder(options: ControlStatsOptions): ControlStatsBuilder {
  return new ControlStatsBuilder(options);
}
