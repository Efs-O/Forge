/** Durable bodies and metadata for conversations beyond recent history. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
import { parseSessionLogRows, readSessionLogRows } from '../sessions/sessionLogRows';
import { deriveTitle, type TitleSource } from './conversationTitle';
import {
  conversationPersistedSchema,
  type ConversationPersisted,
  type SlimPersistMessage,
} from './sessionTypes';
import { screenshotDirectory } from '../tools/browser/screenshotPaths';
import { agentLinksSchema } from '../agentLinks/chatAgentLinks';

/** One archive row. Named apart from the array so a single entry can be parsed
 *  against it (`carryableRows` below rebuilds from a damaged index). */
const indexRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  // `TitleSource` in `conversationTitle.ts`; optional so rows written before
  // it still parse, and `backfill` can tell a name to keep from one to redo.
  title_source: z.enum(['prompt', 'user', 'auto']).optional(),
  // Who started the chat, from `origin_agent` in `conversationTitle`'s naming
  // block: the bus sender's name. Optional, so rows written before it (and rows
  // rebuilt from session logs, which carry no such fact) still parse.
  origin_agent: z.string().min(1).max(64).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number(),
  active_model: z.string().optional(),
  agentLinks: agentLinksSchema.optional(),
  source: z.enum(['body', 'log']).optional(),
});
const indexSchema = z.array(indexRowSchema);
export type ArchivedSessionMeta = z.infer<typeof indexRowSchema>;
/** The overflow archive folder under the workspace storage directory. Exported
 *  because the daily retitle job reads the same files (`src/jobs/retitleRun.ts`)
 *  rather than guessing the name, so moving it moves the job with it. */
export const ARCHIVE_BODIES_DIR = 'archive';
const log = getLogger();

/**
 * What one archived row turns out to be made of, as material a content search
 * can read. `unreadable` is a file that exists but could not be read or parsed;
 * `undefined` from the reader below means the row has no backing file at all.
 * Keeping the two apart is what lets a search say "N saved chats could not be
 * read" instead of reporting them as chats that do not match.
 */
export type ArchivedSearchSource =
  | { kind: 'body'; messages: SlimPersistMessage[] }
  | { kind: 'log'; rows: Array<Record<string, unknown>> }
  | { kind: 'unreadable'; reason: string };

export class ArchivedSessions {
  readonly directory: string;
  private readonly indexPath: string;
  private cache: { key: string; rows: ArchivedSessionMeta[] } | undefined;

  constructor(
    storageDir: string,
    private readonly workspacePath?: string,
    private readonly logsDirectory = path.join(os.homedir(), '.forge', 'sessions'),
  ) {
    this.directory = path.join(storageDir, ARCHIVE_BODIES_DIR);
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
        ...(orphan.agentLinks ? { agentLinks: orphan.agentLinks } : {}),
        ...(orphan.title_source ? { title_source: orphan.title_source } : {}),
        ...(orphan.origin_agent ? { origin_agent: orphan.origin_agent } : {}),
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
    let json: unknown;
    let detail: string;
    try {
      json = JSON.parse(raw);
      const parsed = indexSchema.safeParse(json);
      if (parsed.success) return parsed.data;
      detail = parsed.error.message;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    // Not `.json`: the orphan scan must not pick the quarantined copy up.
    const target = `${this.indexPath}.corrupt-${Date.now()}`;
    fs.renameSync(this.indexPath, target);
    log.error(`[ArchivedSessions] unreadable index moved to ${target}; rebuilding: ${detail}`);
    // A name a person typed, or one the retitle job gave, survives the rebuild;
    // everything else is recomputed from the logs, which is what backfill is for.
    this.backfill(new Set(recentIds), carryableRows(json));
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
      ...(conversation.agentLinks ? { agentLinks: conversation.agentLinks } : {}),
      ...(conversation.title_source ? { title_source: conversation.title_source } : {}),
      ...(conversation.origin_agent ? { origin_agent: conversation.origin_agent } : {}),
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

  /**
   * The material behind one row, read with async IO for the sessions panel's
   * content search, which walks every archived chat during one debounced query
   * and must not block the extension host reading it.
   *
   * Deliberately read-only, unlike `read`: a search that cannot read a file has
   * not proved the file is corrupt, so it reports the failure and moves on
   * rather than quarantining a body, rebuilding the index or deleting the row.
   * The load path (`readBody`, `scan`) owns quarantine and already ran before
   * any panel could open, so nothing here needs to repair storage.
   */
  async readForSearch(row: ArchivedSessionMeta): Promise<ArchivedSearchSource | undefined> {
    if (row.source === 'log') return this.readLogForSearch(row.id);
    return this.readBodyForSearch(row.id);
  }

  private async readBodyForSearch(id: string): Promise<ArchivedSearchSource | undefined> {
    if (!isSafeId(id)) return { kind: 'unreadable', reason: 'invalid archived session id' };
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.bodyPath(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return { kind: 'unreadable', reason: detailOf(error) };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      return { kind: 'unreadable', reason: detailOf(error) };
    }
    const parsed = conversationPersistedSchema.safeParse(json);
    if (!parsed.success) return { kind: 'unreadable', reason: parsed.error.message };
    return { kind: 'body', messages: parsed.data.messages };
  }

  private async readLogForSearch(id: string): Promise<ArchivedSearchSource | undefined> {
    if (!isSafeId(id)) return { kind: 'unreadable', reason: 'invalid archived session id' };
    const file = path.join(this.logsDirectory, `${id}.jsonl`);
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return { kind: 'unreadable', reason: detailOf(error) };
    }
    return { kind: 'log', rows: parseSessionLogRows(raw, file) };
  }

  rename(id: string, title: string, source: TitleSource = 'user'): void {
    const rows = this.list();
    const row = rows.find((item) => item.id === id);
    if (!row) return;
    row.title = title;
    row.title_source = source;
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
   * A permanent delete. Everything this workspace made for the chat goes with
   * it: the body, the session log (the index is rebuilt from the logs whenever
   * it is missing or damaged, and a log left behind brought the deleted chat
   * back into the archive), and the chat's screenshots — `browser_screenshot`
   * and `desktop_capture` captures can hold secrets, so they must not outlive
   * the conversation that made them (ledger BL-012, found 2026-10-30).
   */
  purge(id: string): void {
    this.delete(id);
    try {
      fs.unlinkSync(path.join(this.logsDirectory, `${id}.jsonl`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!isSafeId(id)) return;
    try {
      // A folder a viewer still has open on Windows answers EBUSY/EPERM; that
      // must not turn the chat's deletion into a failure, so it is reported.
      fs.rmSync(screenshotDirectory(id), { recursive: true, force: true });
    } catch (error) {
      log.warn(
        `[ArchivedSessions] could not remove screenshots for ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private bodyPath(id: string): string {
    if (!isSafeId(id)) throw new Error('Invalid archived session id');
    return path.join(this.directory, `${id}.json`);
  }

  private backfill(
    recentIds: ReadonlySet<string>,
    carryFrom: readonly ArchivedSessionMeta[] = [],
  ): void {
    const rows: ArchivedSessionMeta[] = [];
    const carry = new Map(carryFrom.map((row) => [row.id, row]));
    if (this.workspacePath) {
      if (fs.existsSync(this.logsDirectory)) {
        for (const filename of fs.readdirSync(this.logsDirectory)) {
          if (!filename.endsWith('.jsonl')) continue;
          const id = filename.slice(0, -6);
          if (recentIds.has(id)) continue;
          const sessionRows = readSessionLogRows(path.join(this.logsDirectory, filename));
          const start = sessionRows.find((row) => row['type'] === 'session_start');
          if (!start || !samePath(this.stringField(start, 'workspace_path'), this.workspacePath))
            continue;
          // session_start is written before the chat is named ("Untitled chat").
          const firstUser = sessionRows.find(
            (row) => row['role'] === 'user' && typeof row['content'] === 'string',
          );
          // A row carried from the index that was just quarantined keeps its
          // name: recomputing `deriveTitle` from the log would undo a rename the
          // owner made, or one the retitle job made, and the chat would be
          // picked up again by the next run.
          const kept = carry.get(id);
          rows.push({
            id,
            title: kept ? kept.title : deriveTitle(firstUser ? String(firstUser['content']) : ''),
            ...(kept?.title_source ? { title_source: kept.title_source } : {}),
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
    const messages = readSessionLogRows(file).flatMap((row, index) => {
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

/** A read or parse failure, as one line the search can report. */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Index rows worth carrying across a rebuild of a quarantined index: a name a
 * person typed, or one the retitle job gave. Everything else is recomputed from
 * the logs by `backfill`, so a corrupt index cannot smuggle a half-read title
 * into the rebuilt one.
 */
function carryableRows(json: unknown): ArchivedSessionMeta[] {
  if (!Array.isArray(json)) return [];
  const kept: ArchivedSessionMeta[] = [];
  for (const entry of json as unknown[]) {
    const row = indexRowSchema.safeParse(entry);
    if (row.success && (row.data.title_source === 'user' || row.data.title_source === 'auto')) {
      kept.push(row.data);
    }
  }
  return kept;
}

export function isSafeId(id: string): boolean {
  return /^[\w-]+$/.test(id);
}
