/** Durable bodies and metadata for conversations beyond recent history. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { z } from 'zod';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
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

  constructor(
    storageDir: string,
    private readonly workspacePath?: string,
    private readonly logsDirectory = path.join(os.homedir(), '.forge', 'sessions'),
  ) {
    this.directory = path.join(storageDir, 'archive');
    this.indexPath = path.join(this.directory, 'index.json');
  }

  list(recentIds: readonly string[] = []): ArchivedSessionMeta[] {
    if (!fs.existsSync(this.indexPath)) this.backfill(new Set(recentIds));
    try {
      const parsed = indexSchema.parse(JSON.parse(fs.readFileSync(this.indexPath, 'utf8')));
      const valid = parsed.filter(
        (row) =>
          (row.source !== 'log' ||
            fs.existsSync(path.join(this.logsDirectory, `${row.id}.jsonl`))) &&
          (row.source !== 'body' || fs.existsSync(this.bodyPath(row.id))),
      );
      let changed = valid.length !== parsed.length;
      const known = new Set(valid.map((row) => row.id));
      for (const filename of fs.readdirSync(this.directory)) {
        if (!filename.endsWith('.json') || filename === 'index.json') continue;
        const id = filename.slice(0, -5);
        if (known.has(id)) continue;
        const orphan = conversationPersistedSchema.safeParse(
          JSON.parse(fs.readFileSync(path.join(this.directory, filename), 'utf8')),
        );
        if (!orphan.success) {
          log.error(
            `[ArchivedSessions] ignoring invalid orphan body ${filename}: ${orphan.error.message}`,
          );
          continue;
        }
        valid.push({
          id,
          title: orphan.data.title,
          createdAt: orphan.data.createdAt,
          updatedAt: orphan.data.updatedAt,
          messageCount: orphan.data.messages.length,
          ...(orphan.data.active_model ? { active_model: orphan.data.active_model } : {}),
          source: 'body',
        });
        changed = true;
      }
      if (changed) writeFileAtomicSync(this.indexPath, JSON.stringify(valid));
      return valid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
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
    const parsed = conversationPersistedSchema.safeParse(
      JSON.parse(fs.readFileSync(this.bodyPath(id), 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
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

  private bodyPath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid archived session id');
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
          if (!start || start['workspace_path'] !== this.workspacePath) continue;
          rows.push({
            id,
            title: this.stringField(start, 'title') ?? 'Untitled',
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
    const messages = this.readLogRows(file).flatMap((row, index) => {
      if (!['user', 'assistant', 'tool'].includes(String(row['role']))) return [];
      const role = row['role'] as 'user' | 'assistant' | 'tool';
      const content = typeof row['content'] === 'string' ? row['content'] : null;
      const reasoning = this.stringField(row, 'reasoning');
      const rawCalls = Array.isArray(row['tool_calls']) ? row['tool_calls'] : [];
      const tool_calls = rawCalls.flatMap((call, callIndex) => {
        if (typeof call !== 'object' || call === null) return [];
        const value = call as Record<string, unknown>;
        return [
          {
            id: `log-${index}-${callIndex}`,
            type: 'function' as const,
            function: {
              name: typeof value['name'] === 'string' ? value['name'] : 'tool',
              arguments: JSON.stringify(value['input'] ?? {}),
            },
          },
        ];
      });
      return [
        {
          role,
          content,
          ...(reasoning ? { reasoning } : {}),
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
    const seen = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      const canonical = { ...row };
      delete canonical['timestamp_ms'];
      const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      rows.push(row);
    }
    return rows;
  }

  private stringField(row: Record<string, unknown>, key: string): string | undefined {
    return typeof row[key] === 'string' ? row[key] : undefined;
  }

  private numberField(row: Record<string, unknown>, key: string): number | undefined {
    return typeof row[key] === 'number' ? (row[key] as number) : undefined;
  }
}
