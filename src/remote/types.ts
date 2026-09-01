import { z } from 'zod';

const InboundBaseSchema = z.object({
  channel: z.enum(['fake', 'telegram', 'whatsapp']),
  providerMessageId: z.string().min(1).max(256),
  senderId: z.string().min(1).max(256),
  chatId: z.string().min(1).max(256),
  chatType: z.enum(['private', 'group', 'channel']),
  receivedAt: z.number().int().nonnegative(),
});

export const RemoteInboundAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(128),
  /** Base64 for binary input, UTF-8 for text. Never persisted in remote state. */
  data: z
    .string()
    .min(1)
    .max(14 * 1024 * 1024)
    .optional(),
  providerFileId: z.string().min(1).max(256).optional(),
});

export type RemoteInboundAttachment = z.infer<typeof RemoteInboundAttachmentSchema>;

export const RemoteInboundEventSchema = z.discriminatedUnion('kind', [
  InboundBaseSchema.extend({
    kind: z.literal('text'),
    text: z.string(),
    attachments: z.array(RemoteInboundAttachmentSchema).max(10).optional(),
  }),
  InboundBaseSchema.extend({
    kind: z.literal('action'),
    action: z.enum(['approve', 'deny']),
    correlationId: z.string().min(1).max(256),
  }),
  InboundBaseSchema.extend({
    kind: z.literal('selection'),
    selectionKind: z.enum(['models', 'conversations', 'workspaces']),
    selectionToken: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
    action: z.enum(['show', 'close']),
    page: z.number().int().min(0).max(9).optional(),
    messageId: z.string().min(1).max(256),
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
  /** Last conversation whose identity label was included in a durable reply. */
  announcedConversationId?: string | undefined;
}

export interface RemoteRequestRecord {
  id: string;
  dedupKey: string;
  channel: RemoteInboundEvent['channel'];
  chatId: string;
  providerMessageId: string;
  conversationId: string;
  text: string;
  /** Steering prompts run before ordinary queued prompts, FIFO within each class. */
  priority?: 'steer' | undefined;
  attachments?: RemoteAttachmentReference[] | undefined;
  receivedAt: number;
  admittedAt?: number | undefined;
  state: RemoteExecutionState;
  updatedAt: number;
  finalText?: string | undefined;
  error?: string | undefined;
}

/** Durable state contains only a sidecar-relative name and validated metadata. */
export interface RemoteAttachmentReference {
  name: string;
  mediaType: string;
  relativePath: string;
  bytes: number;
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

export interface RemoteTransportHealth {
  ok: boolean;
  detail: string;
}

export interface RemoteSelectionControls {
  kind: 'models' | 'conversations' | 'workspaces';
  token: string;
  page: number;
  pageCount: number;
}

export interface RemoteSelectionPages {
  send(
    chatId: string,
    text: string,
    controls: RemoteSelectionControls,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  edit(
    chatId: string,
    messageId: string,
    text: string,
    controls: RemoteSelectionControls,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  close(chatId: string, messageId: string, options?: { signal?: AbortSignal }): Promise<void>;
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
  /** Best-effort presentation only; never an authoritative remote reply. */
  sendProgress?(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  /** Best-effort presentation only; a reload may lose the provider message id. */
  editMessage?(
    chatId: string,
    messageId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Optional native pagination surface (Telegram inline keyboard). */
  selectionPages?: RemoteSelectionPages;
  /** Fetches attachment bytes only after the controller has authenticated the sender. */
  downloadAttachment?(attachment: RemoteInboundAttachment): Promise<RemoteInboundAttachment>;
  /**
   * Drop the approve/deny buttons from a prompt that has been resolved.
   *
   * Telegram keeps an inline keyboard on a message forever unless the message
   * is edited, so a resolved prompt stays pressable and — with several
   * identical prompts stacked — unreadable. Optional: channels with no such
   * affordance simply do not implement it.
   */
  retractPrompt?(chatId: string, correlationId: string, signal?: AbortSignal): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
  requestPairingCode?(phoneNumber: string): Promise<string>;
  unlink?(): Promise<void>;
  healthCheck?(): Promise<RemoteTransportHealth>;
}
