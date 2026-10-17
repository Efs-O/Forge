import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { writeFileAtomicSync } from '../util/atomicWrite';
import type { AgentSenderMetadata } from './chatAgentLinks';
import { agentSenderMetadataSchema } from './chatAgentLinks';

export const PENDING_AGENT_REPLY_TTL_MS = 24 * 60 * 60_000;

const pendingSchema = z
  .object({
    exchangeId: z.string().uuid(),
    sender: agentSenderMetadataSchema,
    conversationId: z.string().min(1),
    workspace: z.string().min(1),
    ownerPid: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    state: z.enum(['admitted', 'running', 'finished']),
    outcome: z
      .object({
        kind: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
        text: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PendingAgentReply = z.infer<typeof pendingSchema>;

export class PendingAgentReplies {
  private readonly directory: string;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
    private readonly pid: number = process.pid,
  ) {
    this.directory = path.join(root, 'pending-replies');
  }

  create(
    sender: AgentSenderMetadata,
    conversationId: string,
    workspace: string,
  ): PendingAgentReply {
    const record = pendingSchema.parse({
      exchangeId: randomUUID(),
      sender,
      conversationId,
      workspace,
      ownerPid: this.pid,
      createdAt: this.now(),
      state: 'admitted',
    });
    this.write(record);
    return record;
  }

  markRunning(exchangeId: string): PendingAgentReply {
    return this.update(exchangeId, (record) => ({ ...record, state: 'running' }));
  }

  markFinished(exchangeId: string, outcome: PendingAgentReply['outcome']): PendingAgentReply {
    if (!outcome) throw new Error('A pending reply needs its final turn outcome.');
    return this.update(exchangeId, (record) => ({ ...record, state: 'finished', outcome }));
  }

  remove(exchangeId: string): void {
    this.removeFile(this.file(exchangeId));
  }

  list(): PendingAgentReply[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return names.map((name) => {
      const record = pendingSchema.parse(
        JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')),
      );
      if (path.basename(name) !== `${record.exchangeId}.json`)
        throw new Error(`Pending reply filename does not match exchange ${record.exchangeId}.`);
      return record;
    });
  }

  expired(record: PendingAgentReply): boolean {
    return this.now() - record.createdAt >= PENDING_AGENT_REPLY_TTL_MS;
  }

  private update(
    exchangeId: string,
    change: (record: PendingAgentReply) => PendingAgentReply,
  ): PendingAgentReply {
    const file = this.file(exchangeId);
    const current = pendingSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    const next = pendingSchema.parse(change(current));
    this.write(next);
    return next;
  }

  private write(record: PendingAgentReply): void {
    fs.mkdirSync(this.directory, { recursive: true });
    writeFileAtomicSync(this.file(record.exchangeId), `${JSON.stringify(record, null, 2)}\n`);
  }

  private file(exchangeId: string): string {
    const id = z.string().uuid().parse(exchangeId);
    return path.join(this.directory, `${id}.json`);
  }

  private removeFile(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
