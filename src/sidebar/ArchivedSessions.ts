/** Durable bodies and metadata for conversations beyond recent history. */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { conversationPersistedSchema, type ConversationPersisted } from './sessionTypes';

const indexSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    messageCount: z.number(),
    active_model: z.string().optional(),
    source: z.literal('body').optional(),
  }),
);
export type ArchivedSessionMeta = z.infer<typeof indexSchema>[number];

export class ArchivedSessions {
  readonly directory: string;
  private readonly indexPath: string;

  constructor(storageDir: string) {
    this.directory = path.join(storageDir, 'archive');
    this.indexPath = path.join(this.directory, 'index.json');
  }

  list(): ArchivedSessionMeta[] {
    try {
      return indexSchema.parse(JSON.parse(fs.readFileSync(this.indexPath, 'utf8')));
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
    if (!this.list().some((row) => row.id === id)) return undefined;
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
    const body = this.read(id);
    if (body) writeFileAtomicSync(this.bodyPath(id), JSON.stringify({ ...body, title }));
    writeFileAtomicSync(this.indexPath, JSON.stringify(rows));
  }

  delete(id: string): void {
    const rows = this.list().filter((row) => row.id !== id);
    writeFileAtomicSync(this.indexPath, JSON.stringify(rows));
    try {
      fs.unlinkSync(this.bodyPath(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private bodyPath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid archived session id');
    return path.join(this.directory, `${id}.json`);
  }
}
