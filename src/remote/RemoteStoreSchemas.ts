import { z } from 'zod';

const ChannelSchema = z.enum(['fake', 'telegram', 'whatsapp']);

export const RequestSchema = z.object({
  id: z.string(),
  dedupKey: z.string(),
  channel: ChannelSchema,
  chatId: z.string(),
  providerMessageId: z.string(),
  conversationId: z.string(),
  text: z.string(),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        mediaType: z.string().min(1).max(128),
        relativePath: z.string().min(1).max(512),
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(25 * 1024 * 1024),
      }),
    )
    .max(10)
    .optional(),
  receivedAt: z.number(),
  admittedAt: z.number().optional(),
  state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown']),
  updatedAt: z.number(),
  finalText: z.string().optional(),
  error: z.string().optional(),
});

export const OutboxSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  channel: ChannelSchema,
  chatId: z.string(),
  text: z.string(),
  state: z.enum(['pending', 'sending', 'delivered', 'abandoned']),
  attempts: z.number().int().nonnegative(),
  updatedAt: z.number(),
});

export const BindingSchema = z.object({
  channel: ChannelSchema,
  chatId: z.string(),
  workspaceId: z.string(),
  conversationId: z.string(),
  announcedConversationId: z.string().optional(),
});

const LegacyBindingSchema = BindingSchema.omit({ announcedConversationId: true });
const ControlReceiptSchema = z.object({
  dedupKey: z.string(),
  state: z.enum(['pending', 'completed', 'unknown']),
  updatedAt: z.number(),
});

export const RemoteSelectionSchema = z.object({
  channel: ChannelSchema,
  chatId: z.string(),
  kind: z.enum(['models', 'conversations']),
  values: z.array(z.string().min(1).max(512)).min(1).max(100),
  issuedAt: z.number(),
  expiresAt: z.number(),
});
const WorkspaceHandoffSchema = z.object({
  id: z.string(),
  channel: ChannelSchema,
  chatId: z.string(),
  sourceWorkspaceId: z.string(),
  targetWorkspaceId: z.string(),
  targetAlias: z.string(),
  state: z.enum(['pending', 'claimed', 'completed', 'failed', 'expired']),
  createdAt: z.number(),
  updatedAt: z.number(),
  expiresAt: z.number(),
});

export const LegacyRemoteStateSchema = z.object({
  version: z.literal(1),
  requests: z.array(RequestSchema),
  outbox: z.array(OutboxSchema),
  bindings: z.array(LegacyBindingSchema),
  cursors: z.record(z.string(), z.string()),
  controlReceipts: z.array(ControlReceiptSchema).default([]),
});

export const RemoteStateSchema = z.object({
  version: z.literal(2),
  requests: z.array(RequestSchema),
  outbox: z.array(OutboxSchema),
  bindings: z.array(BindingSchema),
  cursors: z.record(z.string(), z.string()),
  controlReceipts: z.array(ControlReceiptSchema).default([]),
  selections: z.array(RemoteSelectionSchema).default([]),
  workspaceHandoffs: z.array(WorkspaceHandoffSchema).default([]),
});

export type RemoteStoreState = z.infer<typeof RemoteStateSchema>;
export type RemoteSelection = z.infer<typeof RemoteSelectionSchema>;
export type WorkspaceHandoff = z.infer<typeof WorkspaceHandoffSchema>;

export const EMPTY_REMOTE_STATE: RemoteStoreState = {
  version: 2,
  requests: [],
  outbox: [],
  bindings: [],
  cursors: {},
  controlReceipts: [],
  selections: [],
  workspaceHandoffs: [],
};

export const MAX_RECORDS = 1_000;
export const MAX_OUTBOX_RECORDS = 1_000;
export const RETENTION_MS = 30 * 24 * 60 * 60_000;
