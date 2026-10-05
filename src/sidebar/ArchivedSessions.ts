/** Durable bodies and metadata for conversations beyond recent history. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { z } from 'zod';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
import { deriveTitle } from './conversationTitle';
import { conversationPersistedSchema, type ConversationPersisted } from './sessionTypes';

const indexSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    messageCount: z.number(),
    active_model: z.string().optional(),
    source: z.enum(['body', 'log']).optional(),
  }),
);
export type ArchivedSessionMeta = z.infer<typeof indexSchema>[number];
const log = getLogger();

export class ArchivedSessions {
  readonly directory: string;
  private readonly indexPath: string;
  private cache: { key: string; rows: ArchivedSessionMeta[] } | undefined;

  constructor(
    storageDir: string,
    private readonly workspacePath?: string,
    private readonly logsDirectory = path.join(os.homedir(), '.forge', 'sessions'),
  ) {
    this.directory = path.join(storageDir, 'archive');
    this.indexPath = path.join(this.directory, 'index.json');
  }

  /**
   * Every archived row. Callers include the session save path, so one bad file
   * must not throw: a corrupt index is moved aside and rebuilt (from the logs
   * and the bodies on disk), and an unreadable body is skipped.
   */
  list(recentIds: readonly string[] = []): ArchivedSessionMeta[] {
    // Every session sync lists the archive; stat three paths instead of
    // checking every row and reading the directory while nothing changed.
    const key = this.cacheKey();
    if (key !== undefined && this.cache?.key === key)
      return this.cache.rows.map((row) => ({ ...row }));
    const rows = this.scan(recentIds);
    const after = this.cacheKey();
    this.cache =
      after === undefined ? undefined : { key: after, rows: rows.map((row) => ({ ...row })) };
    return rows;
  }

  /**
   * Stamps of the index, the body directory (a body added or removed) and the
   * logs directory (a log removed). Undefined when the index is missing.
   */
  private cacheKey(): string | undefined {
    const stamp = (file: string): string | undefined => {
      try {
        const stat = fs.statSync(file);
        return `${stat.mtimeMs}/${stat.ino}/${stat.size}`;
      } catch {
        return undefined;
      }
    };
    const index = stamp(this.indexPath);
    if (index === undefined) return undefined;
    return `${index}:${stamp(this.directory)}:${stamp(this.logsDirectory)}`;
  }

  private scan(recentIds: readonly string[]): ArchivedSessionMeta[] {
    if (!fs.existsSync(this.indexPath)) this.backfill(new Set(recentIds));
    let parsed: ArchivedSessionMeta[];
    try {
      parsed = this.readIndex(recentIds);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const valid = parsed.filter(
      (row) =>
        (row.source !== 'log' || fs.existsSync(path.join(this.logsDirectory, `${row.id}.jsonl`))) &&
        (row.source !== 'body' || (isSafeId(row.id) && fs.existsSync(this.bodyPath(row.id)))),
    );
    let changed = valid.length !== parsed.length;
    const known = new Set(valid.map((row) => row.id));
    for (const filename of fs.readdirSync(this.directory)) {
      if (!filename.endsWith('.json') || filename === 'index.json') continue;
      const id = filename.slice(0, -5);
      // A file whose name is not a body id could never be read or deleted back.
      if (known.has(id) || !isSafeId(id)) continue;
      const orphan = this.readBody(filename);
      if (!orphan) continue;
      valid.push({
        id,
        title: orphan.title,
        createdAt: orphan.createdAt,
        updatedAt: orphan.updatedAt,
        messageCount: orphan.messages.length,
        ...(orphan.active_model ? { active_model: orphan.active_model } : {}),
        source: 'body',
      });
      changed = true;
    }
    if (changed) writeFileAtomicSync(this.indexPath, JSON.stringify(valid));
    return valid;
  }

  /** The parsed index; a corrupt one is moved aside and rebuilt by a fresh backfill. */
  private readIndex(recentIds: readonly string[]): ArchivedSessionMeta[] {
    const raw = fs.readFileSync(this.indexPath, 'utf8');
    let detail: string;
    try {
      const parsed = indexSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      detail = parsed.error.message;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    // Not `.json`: the orphan scan must not pick the quarantined copy up.
    const target = `${this.indexPath}.corrupt-${Date.now()}`;
    fs.renameSync(this.indexPath, target);
    log.error(`[ArchivedSessions] unreadable index moved to ${target}; rebuilding: ${detail}`);
    this.backfill(new Set(recentIds));
    return indexSchema.parse(JSON.parse(fs.readFileSync(this.indexPath, 'utf8')));
  }

  /** A stored body, or undefined (logged) when it is unreadable or invalid. */
  private readBody(filename: string): ConversationPersisted | undefined {
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(path.join(this.directory, filename), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      log.error(`[ArchivedSessions] ignoring unreadable body ${filename}: ${String(error)}`);
      return undefined;
    }
    const parsed = conversationPersistedSchema.safeParse(json);
    if (!parsed.success) {
      log.error(`[ArchivedSessions] ignoring invalid body ${filename}: ${parsed.error.message}`);
      return undefined;
    }
    return parsed.data;
  }

  put(conversation: ConversationPersisted): void {
    fs.mkdirSync(this.directory, { recursive: true });
    writeFileAtomicSync(this.bodyPath(conversation.id), JSON.stringify(conversation));
    const rows = this.list().filter((row) => row.id !== conversation.id);
    rows.push({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
      ...(conversation.active_model ? { active_model: conversation.active_model } : {}),
      source: 'body',
    });
    writeFileAtomicSync(this.indexPath, JSON.stringify(rows));
  }

  read(id: string): ConversationPersisted | undefined {
    const row = this.list().find((item) => item.id === id);
    if (!row) return undefined;
    if (row.source === 'log') return this.readLog(id, row);
    return this.readBody(path.basename(this.bodyPath(id)));
  }

  rename(id: string, title: string): void {
    const rows = this.list();
    const row = rows.find((item) => item.id === id);
    if (!row) return;
    row.title = title;
    const body = row.source === 'log' ? undefined : this.read(id);
    if (body) writeFileAtomicSync(this.bodyPath(id), JSON.stringify({ ...body, title }));
    writeFileAtomicSync(this.indexPath, JSON.stringify(rows));
  }

  delete(id: string): void {
    const rows = this.list().filter((row) => row.id !== id);
    try {
      fs.unlinkSync(this.bodyPath(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    writeFileAtomicSync(this.indexPath, JSON.stringify(rows));
  }

  /**
   * A permanent delete. The session log goes too: the index is rebuilt from the
   * logs whenever it is missing or damaged, and a log left behind brought the
   * deleted chat back into the archive.
   */
  purge(id: string): void {
    this.delete(id);
    try {
      fs.unlinkSync(path.join(this.logsDirectory, `${id}.jsonl`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private bodyPath(id: string): string {
    if (!isSafeId(id)) throw new Error('Invalid archived session id');
    return path.join(this.directory, `${id}.json`);
  }

  private backfill(recentIds: ReadonlySet<string>): void {
    const rows: ArchivedSessionMeta[] = [];
    if (this.workspacePath) {
      if (fs.existsSync(this.logsDirectory)) {
        for (const filename of fs.readdirSync(this.logsDirectory)) {
          if (!filename.endsWith('.jsonl')) continue;
          const id = filename.slice(0, -6);
          if (recentIds.has(id)) continue;
          const sessionRows = this.readLogRows(path.join(this.logsDirectory, filename));
          const start = sessionRows.find((row) => row['type'] === 'session_start');
          if (!start || !samePath(this.stringField(start, 'workspace_path'), this.workspacePath))
            continue;
          // session_start is written before the chat is named ("Untitled chat").
          const firstUser = sessionRows.find(
            (row) => row['role'] === 'user' && typeof row['content'] === 'string',
          );
          rows.push({
            id,
            title: deriveTitle(firstUser ? String(firstUser['content']) : ''),
            createdAt: this.numberField(start, 'timestamp_ms') ?? 0,
            updatedAt: this.numberField(sessionRows.at(-1) ?? start, 'timestamp_ms') ?? 0,
            messageCount: sessionRows.filter((row) =>
              ['user', 'assistant', 'tool'].includes(String(row['role'])),
            ).length,
            ...(this.stringField(start, 'model')
              ? { active_model: this.stringField(start, 'model') }
              : {}),
            source: 'log',
          });
        }
      }
    }
    fs.mkdirSync(this.directory, { recursive: true });
    writeFileAtomicSync(this.indexPath, JSON.stringify(rows));
  }

  private readLog(id: string, meta: ArchivedSessionMeta): ConversationPersisted | undefined {
    const file = path.join(this.logsDirectory, `${id}.jsonl`);
    if (!fs.existsSync(file)) {
      this.delete(id);
      return undefined;
    }
    const pendingCallIds: string[] = [];
    const messages = this.readLogRows(file).flatMap((row, index) => {
      if (!['user', 'assistant', 'tool'].includes(String(row['role']))) return [];
      const role = row['role'] as 'user' | 'assistant' | 'tool';
      const content = typeof row['content'] === 'string' ? row['content'] : null;
      const reasoning = this.stringField(row, 'reasoning');
      const rawCalls = Array.isArray(row['tool_calls']) ? row['tool_calls'] : [];
      const tool_calls = rawCalls.flatMap((call, callIndex) => {
        if (typeof call !== 'object' || call === null) return [];
        const value = call as Record<string, unknown>;
        const callId = typeof value['id'] === 'string' ? value['id'] : `log-${index}-${callIndex}`;
        pendingCallIds.push(callId);
        return [
          {
            id: callId,
            type: 'function' as const,
            function: {
              name: typeof value['name'] === 'string' ? value['name'] : 'tool',
              arguments: JSON.stringify(value['input'] ?? {}),
            },
          },
        ];
      });
      let toolCallId = this.stringField(row, 'tool_call_id');
      if (role === 'tool' && toolCallId) {
        const pendingIndex = pendingCallIds.indexOf(toolCallId);
        if (pendingIndex >= 0) pendingCallIds.splice(pendingIndex, 1);
      } else if (role === 'tool') {
        toolCallId = pendingCallIds.shift();
      }
      return [
        {
          role,
          content,
          ...(toolCallId ? { tool_call_id: toolCallId } : {}),
          ...(this.stringField(row, 'name') ? { name: this.stringField(row, 'name') } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(typeof row['internal'] === 'boolean' ? { internal: row['internal'] } : {}),
          ...(tool_calls.length ? { tool_calls } : {}),
        },
      ];
    });
    return {
      id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      messages,
      ...(meta.active_model ? { active_model: meta.active_model } : {}),
    };
  }

  private readLogRows(file: string): Array<Record<string, unknown>> {
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
      const row = value as Record<string, unknown>;
      parsedRows.push(row);
    }
    if (unreadable > 0) {
      log.warn(`[ArchivedSessions] ${file}: skipped ${unreadable} unreadable line(s)`);
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

  private stringField(row: Record<string, unknown>, key: string): string | undefined {
    return typeof row[key] === 'string' ? row[key] : undefined;
  }

  private numberField(row: Record<string, unknown>, key: string): number | undefined {
    return typeof row[key] === 'number' ? (row[key] as number) : undefined;
  }
}

/** Session logs store the path as VS Code's fsPath gave it (drive letter lower-cased). */
function samePath(logged: string | undefined, workspace: string): boolean {
  if (logged === undefined) return false;
  const a = path.resolve(logged);
  const b = path.resolve(workspace);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isSafeId(id: string): boolean {
  return /^[\w-]+$/.test(id);
}
