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
  session: z
    .object({
      conversation_id: z.string(),
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
      started_at: z.number().nullable(),
      last_request: z
        .object({
          model: z.string(),
          input_tokens: z.number(),
          context_limit: z.number().nullable(),
          at: z.number(),
        })
        .nullable(),
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
  activeConversationId?: () => string | undefined;
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

interface UsageTotals {
  requests: number;
  input: number;
  output: number;
}

interface CountedRows {
  turns: number;
  requests: number;
  compactions: number;
  compaction_attempts_failed: number;
  compactions_suppressed: number;
  tool_calls: number;
  tool_failures: number;
  input_tokens: number;
  output_tokens: number;
  turn_errors: number;
  last_request: ControlStats['last_request'];
}

function emptyCounts(): CountedRows {
  return {
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
    last_request: null,
  };
}

function countRows(
  rows: Array<Record<string, unknown>>,
  day: string | undefined,
  contextLimitFor: (model: string) => number | null,
): [CountedRows, number] {
  const counts = emptyCounts();
  // `usage` rows are session-to-date totals (SessionUsage), so each row's share
  // is the delta from the previous usage row in the same file, whatever day
  // that row was written. A total that went backwards restarted from zero.
  let previousUsage = { requests: 0, input: 0, output: 0 };
  let lastRequestAtMs = -1;
  for (const row of rows) {
    const timestampMs = row['timestamp_ms'];
    if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) continue;
    const type = row['type'];
    const inDay = day === undefined || localDay(timestampMs) === day;
    if (!inDay) {
      if (type === 'usage') previousUsage = usageTotals(row);
      continue;
    }
    if (row['role'] === 'user') counts.turns += 1;
    if (row['role'] === 'tool') {
      counts.tool_calls += 1;
      if (typeof row['content'] === 'string' && isFailureResult(row['content'])) {
        counts.tool_failures += 1;
      }
    }
    if (type === 'usage') {
      const totals = usageTotals(row);
      const delta = usageDelta(previousUsage, totals);
      previousUsage = totals;
      counts.requests += delta.requests;
      counts.input_tokens += delta.input;
      counts.output_tokens += delta.output;
      // Only a single-request delta is one prompt's size; a flush covering
      // several requests holds their sum, which is not a context reading.
      const model = typeof row['model'] === 'string' ? row['model'] : '';
      if (delta.requests === 1 && timestampMs > lastRequestAtMs) {
        lastRequestAtMs = timestampMs;
        counts.last_request = {
          model,
          input_tokens: delta.input,
          context_limit: model ? contextLimitFor(model) : null,
          at: Math.floor(timestampMs / 1_000),
        };
      }
    } else if (type === 'compaction') {
      counts.compactions += 1;
    } else if (type === 'compaction_attempt') {
      if (row['phase'] === 'suppressed') counts.compactions_suppressed += 1;
      else if (row['phase'] === 'finished' && row['outcome'] !== 'compacted') {
        counts.compaction_attempts_failed += 1;
      }
    } else if (type === 'turn_error') {
      counts.turn_errors += 1;
    }
  }
  return [counts, lastRequestAtMs];
}

function usageTotals(row: Record<string, unknown>): UsageTotals {
  return {
    requests: finiteNumber(row['model_request_count']),
    input: finiteNumber(row['input_tokens']),
    output: finiteNumber(row['output_tokens']),
  };
}

function usageDelta(previous: UsageTotals, current: UsageTotals): UsageTotals {
  if (current.requests < previous.requests || current.input < previous.input) return current;
  return {
    requests: current.requests - previous.requests,
    input: current.input - previous.input,
    output: Math.max(0, current.output - previous.output),
  };
}

/** Builds a counts-only summary; persisted row text is never copied to the reply. */
export class ControlStatsBuilder {
  private readonly fileCache = new Map<string, FileCacheEntry>();
  private cachedReply: ControlStats | undefined;
  private cachedAtMs = 0;
  private cachedActiveId: string | undefined;

  constructor(private readonly options: ControlStatsOptions) {}

  build(): ControlStats {
    const nowMs = this.options.now();
    const day = localDay(nowMs);
    const activeId = this.options.activeConversationId?.();
    if (
      this.cachedReply?.day === day &&
      activeId === this.cachedActiveId &&
      nowMs >= this.cachedAtMs &&
      nowMs - this.cachedAtMs < 3_000
    ) {
      return this.cachedReply;
    }

    const files = this.filesForDay(day);
    const activeFile = this.activeFile(activeId);
    const todayPaths = new Set(files.map((file) => file.path));
    if (activeFile) todayPaths.add(activeFile.path);
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
      session: activeFile ? this.emptySession(activeId!) : null,
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

      const [counted, requestAtMs] = countRows(rows, day, this.options.contextLimitFor);
      for (const key of Object.keys(result.today) as Array<keyof typeof result.today>) {
        result.today[key] += counted[key];
      }
      if (counted.last_request && requestAtMs > lastRequestAtMs) {
        lastRequestAtMs = requestAtMs;
        result.last_request = counted.last_request;
      }
    }

    if (activeFile && result.session) this.readActiveSession(activeFile, result, activeId!);

    this.cachedAtMs = nowMs;
    this.cachedActiveId = activeId;
    this.cachedReply = controlStatsSchema.parse(result);
    return this.cachedReply;
  }

  private emptySession(conversationId: string): NonNullable<ControlStats['session']> {
    return { conversation_id: conversationId, ...emptyCounts(), started_at: null };
  }

  private activeFile(
    id: string | undefined,
  ): { path: string; size: number; mtimeMs: number; missing?: boolean } | null {
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const filePath = path.join(this.options.sessionsDir, `${id}.jsonl`);
    try {
      const stat = fs.statSync(filePath);
      return stat.isFile()
        ? { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs }
        : { path: filePath, size: -1, mtimeMs: -1, missing: true };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return { path: filePath, size: -1, mtimeMs: -1, missing };
    }
  }

  private readActiveSession(
    file: { path: string; size: number; mtimeMs: number; missing?: boolean },
    result: ControlStats,
    activeId: string,
  ): void {
    const session = result.session;
    if (!session) return;
    if (file.size < 0) {
      if (!file.missing) result.skipped_files += 1;
      return;
    }
    try {
      const rows = this.rowsForFile(file.path, file.size, file.mtimeMs);
      if (!rows.some((row) => row['type'] === 'session_start')) return;
      const firstTimestamp = rows[0]?.['timestamp_ms'];
      session.started_at =
        typeof firstTimestamp === 'number' && Number.isFinite(firstTimestamp)
          ? Math.floor(firstTimestamp / 1_000)
          : null;
      const [counts] = countRows(rows, undefined, this.options.contextLimitFor);
      Object.assign(session, counts, { conversation_id: activeId });
    } catch {
      result.skipped_files += 1;
      this.fileCache.delete(file.path);
    }
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
