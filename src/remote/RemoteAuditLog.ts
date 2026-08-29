import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { redactRemoteIdentity } from './RemoteAuth';
import type { RemoteInboundEvent } from './types';

const AuditEntrySchema = z.object({
  timestamp: z.number().int().nonnegative(),
  channel: z.enum(['fake', 'telegram', 'whatsapp']),
  action: z.string().min(1).max(80),
  senderHash: z.string().length(12),
  chatHash: z.string().length(12),
  requestId: z.string().optional(),
});
const AuditSchema = z.object({ version: z.literal(1), entries: z.array(AuditEntrySchema) });
type AuditState = z.infer<typeof AuditSchema>;
const MAX_AUDIT_ENTRIES = 2_000;

/** Metadata-only audit trail: no prompt, response, path, token, or raw identity. */
export class RemoteAuditLog {
  private state: AuditState = { version: 1, entries: [] };
  private tail: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async record(event: RemoteInboundEvent, action: string, requestId?: string): Promise<void> {
    const operation = this.tail.then(async () => {
      await this.load();
      this.state.entries.push({
        timestamp: Date.now(),
        channel: event.channel,
        action: action.slice(0, 80),
        senderHash: redactRemoteIdentity(event.senderId),
        chatHash: redactRemoteIdentity(event.chatId),
        ...(requestId ? { requestId } : {}),
      });
      this.state.entries = this.state.entries.slice(-MAX_AUDIT_ENTRIES);
      await this.persist();
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      this.state = AuditSchema.parse(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }
}
