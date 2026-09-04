import { z } from 'zod';
import type * as vscode from 'vscode';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteRequestStore } from './RemoteRequestStore';

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
  /**
   * A voice note. Deliberately NOT a `text` event with an audio attachment:
   * `RemoteInboundAttachment.data` is a string, and putting audio through it
   * would base64-inflate it against a 14 MB cap and then be written back out to
   * a temp file two steps later anyway (§9.2). Only the file id crosses here;
   * the bytes go straight to disk via `downloadAttachmentToFile`.
   */
  InboundBaseSchema.extend({
    kind: z.literal('voice'),
    providerFileId: z.string().min(1).max(256),
    mediaType: z.string().min(1).max(128),
    /**
     * Client-reported clip length. Load-bearing twice over: it rejects an
     * over-long note before a byte is downloaded, and with `receivedAt` it
     * defines the recording window that correlates a spoken command to one
     * pending approval (§22A R1-revised).
     */
    durationMs: z.number().int().nonnegative(),
    /** Set when the note was sent as a reply; wins over the timing heuristic. */
    replyToMessageId: z.string().min(1).max(256).optional(),
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
   * Stream a provider file straight to `targetPath` and report what landed.
   *
   * Separate from `downloadAttachment` because that one returns the payload as
   * a string on the event, which audio must never become (§9.2). The caller
   * owns `targetPath` -- in the voice path that is a `VoiceOperation` temp file,
   * so cleanup stays keyed to the operation rather than to a stray `finally`.
   */
  /**
   * Deliver a spoken reply as a playable voice message. Optional: channels with
   * no such affordance simply do not implement it, and speech is skipped.
   */
  sendVoice?(chatId: string, oggPath: string, signal?: AbortSignal): Promise<void>;
  downloadAttachmentToFile?(
    providerFileId: string,
    targetPath: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: number; mediaType: string }>;
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

/**
 * What the sidebar chip reports. Deliberately Forge's own view and not a health
 * check: `transports` means `channel.start()` resolved and the transport has not
 * been stopped, and `paired` means an owner id is in SecretStorage. A revoked
 * token or a dropped long-poll still reads as running until a send fails, and
 * claiming otherwise would need a heartbeat that does not exist.
 */
export interface RemoteStatus {
  /** Running transports, sorted, so the value is comparable between polls. */
  transports: Array<RemoteInboundEvent['channel']>;
  /** True when at least one running transport has a paired owner. */
  paired: boolean;
}

/**
 * Construction options for the extension-scoped remote runtime. Lives here
 * (not in RemoteRuntime.ts) so RemoteTransportManager can import it without
 * importing the runtime class back — the dependency must point one way.
 */
export interface RemoteChannelFactoryContext {
  getCursor: (key: string) => string | undefined;
  setCursor: (key: string, value: string) => Promise<void>;
}
export type RemoteChannelFactory = (
  context: RemoteChannelFactoryContext,
) => Promise<RemoteChannel> | RemoteChannel;

export interface RemoteRuntimeOptions {
  storageDirectory: string;
  workspaceRoot?: string | undefined;
  workspaceId: string;
  host: ForgeHostFacade;
  secrets: vscode.SecretStorage;
  channelFactories?: Partial<Record<'telegram' | 'whatsapp', RemoteChannelFactory>>;
  notifyLocal: (message: string) => void;
  /**
   * Fired whenever the set of running transports or the paired-owner state
   * changes. The listener reads `status()` - which has to await SecretStorage -
   * rather than being handed a value, so the notification stays synchronous and
   * cannot interleave with the lifecycle operation that raised it.
   */
  onStatusChanged?: (() => void) | undefined;
  setInactivityTimeout?: ((minutes: number) => Promise<void>) | undefined;
  reloadWindow?: (() => Promise<void>) | undefined;
  openWorkspace?: ((directory: string) => Promise<void>) | undefined;
  confirmWhisperServerStart?: ((detail: string) => Promise<boolean>) | undefined;
  /** Absolute path to `.forge/config.yaml`; enables the persisted /voice toggle. */
  configPath?: string | undefined;
  /** Handoff watch/rollback timings. Present so a test need not wait out the
   *  real ones; production uses the coordinator's defaults. */
  handoffWatch?: { pollIntervalMs?: number; rollbackDelayMs?: number } | undefined;
}

export interface RemoteValidationStatus {
  enabled: boolean;
  transports: Array<{
    name: 'telegram' | 'whatsapp';
    configured: boolean;
    active: boolean;
    ownerPaired: boolean;
    totpEnrolled: boolean;
    leaseOwned: boolean;
    providerOk: boolean;
    detail: string;
  }>;
  requests: ReturnType<RemoteRequestStore['requestHealth']>;
  outbox: ReturnType<RemoteRequestStore['outboxHealth']>;
}
