import { z } from 'zod';

const InboundBaseSchema = z.object({
  channel: z.enum(['fake', 'telegram', 'whatsapp']),
  providerMessageId: z.string().min(1).max(256),
  senderId: z.string().min(1).max(256),
  chatId: z.string().min(1).max(256),
  chatType: z.enum(['private', 'group', 'channel']),
  receivedAt: z.number().int().nonnegative(),
});

export const RemoteInboundEventSchema = z.discriminatedUnion('kind', [
  InboundBaseSchema.extend({ kind: z.literal('text'), text: z.string() }),
  InboundBaseSchema.extend({
    kind: z.literal('action'),
    action: z.enum(['approve', 'deny']),
    correlationId: z.string().min(1).max(256),
  }),
]);

export type RemoteInboundEvent = z.infer<typeof RemoteInboundEventSchema>;

export type RemoteInboundDisposition =
  | { kind: 'accepted'; requestId: string }
  | { kind: 'queued'; requestId: string; position: number }
  | { kind: 'handled' }
  | { kind: 'duplicate'; requestId: string; state: RemoteExecutionState }
  | { kind: 'rejected'; reason: string }
  | { kind: 'retry'; reason: string };

export type RemoteExecutionState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface RemoteBinding {
  channel: RemoteInboundEvent['channel'];
  chatId: string;
  workspaceId: string;
  conversationId: string;
}

export interface RemoteRequestRecord {
  id: string;
  dedupKey: string;
  channel: RemoteInboundEvent['channel'];
  chatId: string;
  providerMessageId: string;
  conversationId: string;
  text: string;
  receivedAt: number;
  admittedAt?: number | undefined;
  state: RemoteExecutionState;
  updatedAt: number;
  finalText?: string | undefined;
  error?: string | undefined;
}

export interface RemoteOutboxRecord {
  id: string;
  requestId: string;
  channel: RemoteInboundEvent['channel'];
  chatId: string;
  text: string;
  state: 'pending' | 'sending' | 'delivered' | 'abandoned';
  attempts: number;
  updatedAt: number;
}

export interface RemoteChannel {
  readonly name: RemoteInboundEvent['channel'];
  onEvent(handler: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>): {
    dispose(): void;
  };
  send(
    chatId: string,
    text: string,
    options?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
  requestPairingCode?(phoneNumber: string): Promise<string>;
  unlink?(): Promise<void>;
}
