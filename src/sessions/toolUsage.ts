import * as fs from 'fs';
import * as path from 'path';
import { readSessionLogRows } from './sessionLogRows';
import { writeFileAtomicSync } from '../util/atomicWrite';

const MAX_DAYS = 30;

interface ToolCall {
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

interface UsageRow extends Record<string, unknown> {
  timestamp_ms?: number;
  type?: string;
  role?: string;
  tool_calls?: unknown;
}

interface ToolCounts {
  calls: number;
  offered_calls: number;
  hidden_calls: number;
  failures: number;
  sessions: Set<string>;
}

interface Bucket {
  version: string;
  model: string;
  sessions: Set<string>;
  tools: Map<string, ToolCounts>;
  lazyGroups: Map<string, number>;
  workarounds: Map<string, number>;
}

export interface ToolUsageReport {
  date: string;
  builds: Array<{
    forge_version: string;
    models: Array<{
      model: string;
      sessions: number;
      tools: Array<{
        tool: string;
        calls: number;
        sessions: number;
        failures: number;
        offered_calls: number;
        hidden_calls: number;
      }>;
      lazy_groups: Array<{ group: string; loads: number }>;
      shell_workarounds: Array<{ tool: string; calls: number }>;
    }>;
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayStart(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date!).getTime();
}

function previousLocalDay(now: Date): string {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return localDay(yesterday.getTime());
}

function datesThrough(endDay: string, oldestTimestamp: number | undefined): string[] {
  const end = new Date(dayStart(endDay));
  const afterEnd = new Date(end);
  afterEnd.setDate(afterEnd.getDate() + 1);
  const floor = new Date(end);
  floor.setDate(floor.getDate() - (MAX_DAYS - 1));
  const oldestDay =
    oldestTimestamp === undefined ? end : new Date(dayStart(localDay(oldestTimestamp)));
  const cappedOldest = oldestDay < floor ? floor : oldestDay;
  const oldest = cappedOldest > end ? end : cappedOldest;
  const dates: string[] = [];
  for (const at = new Date(oldest); at < afterEnd; at.setDate(at.getDate() + 1))
    dates.push(localDay(at.getTime()));
  return dates;
}

function commandTokens(command: string): string[] {
  return command.match(/[\w@.\\/:+-]+/gu)?.map((token) => token.toLowerCase()) ?? [];
}

function executable(token: string): string {
  return path.win32.basename(token).replace(/\.exe$/u, '');
}

function workaroundTargets(command: unknown, scripts: Map<string, string>): string[] {
  if (typeof command !== 'string') return [];
  const tokens = commandTokens(command);
  const targets = new Set<string>();
  const hasPackage = tokens.some((token) =>
    /^(?:three|puppeteer|playwright|playwright-core)(?:@\d[\w.-]*)?$/u.test(token),
  );
  if (
    tokens.some(
      (token, i) =>
        ['npm', 'pnpm'].includes(executable(token)) &&
        ['i', 'install', 'add'].includes(tokens[i + 1] ?? ''),
    ) &&
    hasPackage
  ) {
    targets.add('render_html_to_image');
  }
  if (tokens.some((token) => ['node', 'nodejs'].includes(executable(token)))) {
    const sources = tokens
      .filter((token) => /\.(?:c|m)?js$/u.test(token))
      .map(
        (token) =>
          scripts.get(token.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase()) ?? '',
      )
      .join('\n');
    if (
      /\b(?:require\s*\(|from\s+|import\s*\()\s*['"](?:three|puppeteer|playwright(?:-core)?)(?:\/[^'"]*)?['"]/u.test(
        `${command}\n${sources}`,
      )
    ) {
      targets.add('render_html_to_image');
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const exe = executable(tokens[i]!);
    if (exe === 'git' && tokens[i + 1] === 'commit') targets.add('commit');
    if ((exe === 'git' && tokens[i + 1] === 'mv') || ['mv', 'move-item'].includes(exe))
      targets.add('move_file');
    if (exe === 'mkdir' || (exe === 'new-item' && tokens.includes('directory')))
      targets.add('create_directory');
    if (
      !tokens.includes('recurse') &&
      !tokens.some((token) => /^-[a-z]*r[a-z]*$/u.test(token)) &&
      (exe === 'rm' || exe === 'remove-item') &&
      !(tokens[i - 1] === 'git')
    )
      targets.add('delete_file');
    if (['sleep', 'start-sleep'].includes(exe)) targets.add('background wait');
  }
  return [...targets];
}

function countFailure(result: UsageRow | undefined, name: string): boolean {
  const content = result?.['content'];
  return (
    typeof content === 'string' &&
    (/^(?:Error:|User declined:)/u.test(content) ||
      (name === 'shell' && /^exit (?!0\b)(?:\d+|null)\b/u.test(content)))
  );
}

function callInput(call: ToolCall): Record<string, unknown> {
  return isRecord(call.input) ? call.input : {};
}

function recordHeredoc(command: string, scripts: Map<string, string>): void {
  const match = command.match(
    /\bcat\s*>\s*([^\s]+\.(?:c|m)?js)\s*<<\s*['"]?([\w-]+)['"]?\r?\n([\s\S]*?)\r?\n\2(?:\s|$)/u,
  );
  if (match)
    scripts.set(match[1]!.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase(), match[3]!);
}

function addCall(
  bucket: Bucket,
  tool: string,
  offered: boolean,
  failed: boolean,
  session: string,
): void {
  let counts = bucket.tools.get(tool);
  if (!counts) {
    counts = { calls: 0, offered_calls: 0, hidden_calls: 0, failures: 0, sessions: new Set() };
    bucket.tools.set(tool, counts);
  }
  counts.calls += 1;
  counts[offered ? 'offered_calls' : 'hidden_calls'] += 1;
  if (failed) counts.failures += 1;
  counts.sessions.add(session);
}

function bucketFor(buckets: Map<string, Bucket>, version: string, model: string): Bucket {
  const key = `${version}\0${model}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      version,
      model,
      sessions: new Set(),
      tools: new Map(),
      lazyGroups: new Map(),
      workarounds: new Map(),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

function reportDay(
  day: string,
  sessions: Array<{ id: string; rows: UsageRow[] }>,
): ToolUsageReport {
  const buckets = new Map<string, Bucket>();
  const start = dayStart(day);
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + 1);
  const end = endDate.getTime();
  for (const session of sessions) {
    let version = 'unknown';
    let model = 'unknown';
    let activeBucket: Bucket | undefined;
    let visible = new Set<string>();
    const everOffered = new Set<string>();
    const scripts = new Map<string, string>();
    const results = new Map<string, UsageRow>();
    for (const row of session.rows) {
      if (row.role === 'tool' && typeof row['tool_call_id'] === 'string')
        results.set(row['tool_call_id'], row);
    }
    for (const row of session.rows) {
      if (row.type === 'session_start') {
        if (typeof row['forge_version'] === 'string') version = row['forge_version'];
        if (typeof row['model'] === 'string') model = row['model'];
        activeBucket = bucketFor(buckets, version, model);
      }
      if (row.type === 'tools_offered' && Array.isArray(row['names'])) {
        visible = new Set(row['names'].filter((name): name is string => typeof name === 'string'));
        for (const name of visible) everOffered.add(name);
      }
      if (
        activeBucket &&
        typeof row.timestamp_ms === 'number' &&
        row.timestamp_ms >= start &&
        row.timestamp_ms < end
      ) {
        activeBucket.sessions.add(session.id);
      }
      if (row.role !== 'assistant' || !Array.isArray(row.tool_calls)) continue;
      const timestamp = row.timestamp_ms;
      const isDay = typeof timestamp === 'number' && timestamp >= start && timestamp < end;
      const calls = row.tool_calls.filter(isRecord) as ToolCall[];
      for (const call of calls) {
        const input = callInput(call);
        if (
          ['write_file', 'append_file'].includes(String(call.name)) &&
          typeof input['path'] === 'string' &&
          typeof input['content'] === 'string'
        ) {
          const key = input['path'].replaceAll('\\', '/').replace(/^\.\//u, '');
          scripts.set(
            key.toLowerCase(),
            call.name === 'append_file'
              ? `${scripts.get(key.toLowerCase()) ?? ''}${input['content']}`
              : input['content'],
          );
        }
        if (call.name === 'shell') {
          const command = input['command'] ?? input['cmd'];
          if (typeof command === 'string') recordHeredoc(command, scripts);
        }
        if (!isDay || !activeBucket || typeof call.name !== 'string') continue;
        addCall(
          activeBucket,
          call.name,
          visible.has(call.name),
          countFailure(typeof call.id === 'string' ? results.get(call.id) : undefined, call.name),
          session.id,
        );
        if (call.name === 'load_tool_group' && typeof input['group'] === 'string') {
          activeBucket.lazyGroups.set(
            input['group'],
            (activeBucket.lazyGroups.get(input['group']) ?? 0) + 1,
          );
        }
        if (call.name === 'shell') {
          for (const target of workaroundTargets(input['command'] ?? input['cmd'], scripts)) {
            if (!visible.has(target) && !everOffered.has(target)) {
              activeBucket.workarounds.set(target, (activeBucket.workarounds.get(target) ?? 0) + 1);
            }
          }
        }
      }
    }
  }
  const versions = [...buckets.values()].sort((a, b) => a.version.localeCompare(b.version));
  const builds = [...new Set(versions.map((bucket) => bucket.version))].map((version) => ({
    forge_version: version,
    models: versions
      .filter((bucket) => bucket.version === version)
      .sort((a, b) => a.model.localeCompare(b.model))
      .map((bucket) => ({
        model: bucket.model,
        sessions: bucket.sessions.size,
        tools: [...bucket.tools]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([tool, counts]) => ({
            tool,
            calls: counts.calls,
            sessions: counts.sessions.size,
            failures: counts.failures,
            offered_calls: counts.offered_calls,
            hidden_calls: counts.hidden_calls,
          })),
        lazy_groups: [...bucket.lazyGroups]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([group, loads]) => ({ group, loads })),
        shell_workarounds: [...bucket.workarounds]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([tool, calls]) => ({ tool, calls })),
      })),
  }));
  return { date: day, builds };
}

/** Compute up to 30 local calendar days, including the previous complete day. */
export function computeToolUsageReports(
  sessionDirectory: string,
  endDay: string,
): ToolUsageReport[] {
  // A log last written before the window holds no row inside it. Skipping those keeps the
  // synchronous read to the last 30 days of logs, not the whole archive (263 MB on 2026-10-09).
  const windowStart = new Date(dayStart(endDay));
  windowStart.setDate(windowStart.getDate() - (MAX_DAYS - 1));
  const files = fs.existsSync(sessionDirectory)
    ? fs
        .readdirSync(sessionDirectory)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .map((name) => path.join(sessionDirectory, name))
        .filter((file) => fs.statSync(file).mtimeMs >= windowStart.getTime())
    : [];
  const sessions = files.map((file) => ({
    id: path.basename(file),
    rows: readSessionLogRows(file) as UsageRow[],
  }));
  const timestamps = sessions.flatMap(({ rows }) =>
    rows.map((row) => row.timestamp_ms).filter((time): time is number => typeof time === 'number'),
  );
  return datesThrough(endDay, timestamps.length ? Math.min(...timestamps) : undefined).map((day) =>
    reportDay(day, sessions),
  );
}

/** Atomically recompute the requested reports; no timestamp makes reruns byte-identical. */
export function writeToolUsageReports(
  sessionDirectory: string,
  outputDirectory: string,
  endDay: string,
): ToolUsageReport[] {
  const reports = computeToolUsageReports(sessionDirectory, endDay);
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const report of reports) {
    writeFileAtomicSync(
      path.join(outputDirectory, `${report.date}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return reports;
}

export function previousCompleteLocalDay(now = new Date()): string {
  return previousLocalDay(now);
}
