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
  priority: z.literal('steer').optional(),
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
  kind: z.enum(['models', 'conversations', 'workspaces']),
  /** Opaque pagination capability. Optional for state written before 0.15.7. */
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{12}$/)
    .optional(),
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

const ContactPendingSchema = z.object({
  id: z.string().min(1).max(128),
  telegramChatId: z.string().regex(/^-?[0-9]{1,32}$/),
  telegramUserId: z.string().regex(/^[0-9]{1,32}$/),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  status: z.enum(['pending', 'approved', 'rejected']),
});

const ContactSchema = z.object({
  id: z.string().min(1).max(128),
  displayName: z.string().trim().min(1).max(80),
  telegramChatId: z.string().regex(/^-?[0-9]{1,32}$/),
  telegramUserId: z.string().regex(/^[0-9]{1,32}$/),
  role: z.literal('contact_only'),
  status: z.enum(['active', 'disabled']),
  groupStatus: z.enum(['unbound', 'link_pending', 'bound']).default('unbound'),
  groupChatId: z
    .string()
    .regex(/^-?[0-9]{1,32}$/)
    .optional(),
  groupTitle: z.string().trim().min(1).max(256).optional(),
  groupBoundAt: z.number().int().nonnegative().optional(),
  groupVerifiedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

const ContactGroupLinkSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,48}$/),
  contactId: z.string().min(1).max(128),
  groupChatId: z.string().regex(/^-?[0-9]{1,32}$/),
  groupTitle: z.string().trim().min(1).max(256).optional(),
  ownerId: z.string().regex(/^[0-9]{1,32}$/),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  state: z.enum(['pending', 'confirmed', 'cancelled', 'expired']),
});

const ContactThreadMessageSchema = z.object({
  id: z.string().min(1).max(128),
  contactId: z.string().min(1).max(128),
  role: z.enum(['contact', 'owner', 'assistant']),
  text: z.string().min(1).max(12_000),
  createdAt: z.number().int().nonnegative(),
  inboundKey: z.string().min(1).max(200).optional(),
  disposition: z.enum(['pending', 'running', 'answered', 'failed']).optional(),
});

const ContactOutboundSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,48}$/),
  contactId: z.string().min(1).max(128),
  ownerId: z.string().regex(/^[0-9]{1,32}$/),
  ownerChatId: z.string().regex(/^-?[0-9]{1,32}$/),
  recipientChatId: z.string().regex(/^-?[0-9]{1,32}$/),
  recipientDisplayName: z.string().trim().min(1).max(80),
  text: z.string().min(1).max(12_000),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  state: z.enum(['pending', 'confirmed', 'cancelled', 'expired', 'sent', 'failed']),
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
  contactPending: z.array(ContactPendingSchema).default([]),
  contacts: z.array(ContactSchema).default([]),
  contactGroupLinks: z.array(ContactGroupLinkSchema).default([]),
  contactThread: z.array(ContactThreadMessageSchema).default([]),
  contactOutbound: z.array(ContactOutboundSchema).default([]),
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
  contactPending: [],
  contacts: [],
  contactGroupLinks: [],
  contactThread: [],
  contactOutbound: [],
};

export const MAX_RECORDS = 1_000;
export const MAX_OUTBOX_RECORDS = 1_000;
export const RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * v1 → v2. Selections and workspace handoffs are window-lifetime concerns with
 * short expiries, so an upgrade starts them empty rather than inventing history.
 */
export function migrateLegacyState(
  legacy: z.infer<typeof LegacyRemoteStateSchema>,
): RemoteStoreState {
  return {
    version: 2,
    requests: legacy.requests,
    outbox: legacy.outbox,
    bindings: legacy.bindings,
    cursors: legacy.cursors,
    controlReceipts: legacy.controlReceipts,
    selections: [],
    workspaceHandoffs: [],
    contactPending: [],
    contacts: [],
    contactGroupLinks: [],
    contactThread: [],
    contactOutbound: [],
  };
}
