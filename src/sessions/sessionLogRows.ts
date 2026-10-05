/** Replay-aware reader for Forge session-log JSONL rows. */
import * as fs from 'fs';
import { createHash } from 'crypto';
import { getLogger } from '../util/logger';

const log = getLogger();

/**
 * Read complete JSON object rows, skipping torn lines and collapsing transcript
 * replays from both legacy append-on-resume logs and cursor-based logs.
 */
export function readSessionLogRows(file: string): Array<Record<string, unknown>> {
  const parsedRows: Array<Record<string, unknown>> = [];
  let unreadable = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A crash mid-append leaves a torn last line; it must not hide the log.
      unreadable += 1;
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    parsedRows.push(value as Record<string, unknown>);
  }
  if (unreadable > 0) {
    log.warn(`[sessionLogRows] ${file}: skipped ${unreadable} unreadable line(s)`);
  }
  const rows: Array<Record<string, unknown>> = [];
  const historyHashes: string[] = [];
  const acceptedHashes: string[] = [];
  const hashRow = (row: Record<string, unknown>): string => {
    const canonical = { ...row };
    delete canonical['timestamp_ms'];
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  };
  const parsedHashes = parsedRows.map(hashRow);
  // Accepted positions per hash, so a legacy replay scan only visits starts that match.
  const acceptedStarts = new Map<string, number[]>();
  const hasCursor = parsedRows.some((row) => row['type'] === 'cursor');
  let expectedReplay: string[] | undefined;
  let replayBuffer: Array<{ row: Record<string, unknown>; hash: string }> = [];
  const appendRow = (row: Record<string, unknown>, hash: string): void => {
    rows.push(row);
    const starts = acceptedStarts.get(hash);
    if (starts) starts.push(acceptedHashes.length);
    else acceptedStarts.set(hash, [acceptedHashes.length]);
    acceptedHashes.push(hash);
    if (['user', 'assistant', 'tool'].includes(String(row['role']))) historyHashes.push(hash);
  };
  const flushReplayBuffer = (): void => {
    for (const item of replayBuffer) appendRow(item.row, item.hash);
    replayBuffer = [];
    expectedReplay = undefined;
  };
  for (let index = 0; index < parsedRows.length; index += 1) {
    const row = parsedRows[index]!;
    if (row['type'] === 'cursor' && typeof row['written_count'] === 'number') {
      flushReplayBuffer();
      expectedReplay = hasCursor
        ? historyHashes.slice(0, Math.max(0, row['written_count']))
        : undefined;
      if (expectedReplay?.length === 0) expectedReplay = undefined;
      rows.push(row);
      continue;
    }
    const role = row['role'];
    const hash = parsedHashes[index]!;
    if (expectedReplay && ['user', 'assistant', 'tool'].includes(String(role))) {
      const offset = replayBuffer.length;
      if (hash === expectedReplay[offset]) {
        replayBuffer.push({ row, hash });
        if (replayBuffer.length === expectedReplay.length) {
          replayBuffer = [];
          expectedReplay = undefined;
        }
        continue;
      }
      // A matching single row is not enough to call it a replay. Once the
      // sequence diverges, preserve every buffered row as new transcript.
      flushReplayBuffer();
    }
    if (!hasCursor) {
      // Pre-cursor logs re-appended the full transcript on each reload.
      // Collapse only a repeated contiguous run; equal individual rows are valid data.
      let replayLength = 0;
      for (const start of acceptedStarts.get(hash) ?? []) {
        let length = 0;
        while (
          index + length < parsedRows.length &&
          start + length < acceptedHashes.length &&
          parsedHashes[index + length] === acceptedHashes[start + length]
        ) {
          length += 1;
        }
        replayLength = Math.max(replayLength, length);
      }
      if (replayLength >= 2) {
        index += replayLength - 1;
        continue;
      }
    }
    appendRow(row, hash);
  }
  flushReplayBuffer();
  return rows;
}
