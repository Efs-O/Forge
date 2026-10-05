import type * as vscode from 'vscode';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RichDraftTransport } from './telegramRichDraft';
import type { RemoteInboundAttachment, RemoteInboundEvent } from './remoteInboundSchema';

/**
 * The inbound event contract lives in `remoteInboundSchema.ts` and is
 * re-exported here, so `types.ts` stays the one import site for the remote
 * surface. It moved out because this barrel had reached the lint line limit and
 * the keyboard-resolution affordance below (plus the media variants the next
 * phase adds) needed the room. The type-only import above is what lets the rest
 * of this file keep naming those types locally.
 */
export {
  RemoteInboundAttachmentSchema,
  RemoteInboundEventSchema,
  type RemoteInboundAttachment,
  type RemoteInboundEvent,
} from './remoteInboundSchema';

export type RemoteInboundDisposition =
  | { kind: 'accepted'; requestId: string }
  | { kind: 'queued'; requestId: string; position: number }
  | { kind: 'handled' }
  | { kind: 'duplicate'; requestId: string; state: RemoteExecutionState }
  | { kind: 'rejected'; reason: string; ephemeral?: boolean }
  | { kind: 'retry'; reason: string };

export type EphemeralKind = 'queued' | 'transient';

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

export type RemoteFileSendResult =
  | { kind: 'sent' }
  | { kind: 'refused'; error: string }
  | { kind: 'unknown'; error: string };

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
  /** Lease epoch and process identity for a running claim. Older records omit it. */
  claimOwner?: { token: string; pid: number; startedAt: number } | undefined;
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

export type RemoteContactStatus = 'active' | 'disabled';
export type RemoteContactGroupStatus = 'unbound' | 'link_pending' | 'bound';

export interface RemoteContactRecord {
  id: string;
  displayName: string;
  telegramChatId: string;
  telegramUserId: string;
  role: 'contact_only';
  status: RemoteContactStatus;
  groupStatus: RemoteContactGroupStatus;
  groupChatId?: string | undefined;
  groupTitle?: string | undefined;
  groupBoundAt?: number | undefined;
  groupVerifiedAt?: number | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface RemoteContactGroupLinkRecord {
  id: string;
  contactId: string;
  groupChatId: string;
  groupTitle?: string | undefined;
  ownerId: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  state: 'pending' | 'confirmed' | 'cancelled' | 'expired';
}

export interface RemoteContactPendingRecord {
  id: string;
  telegramChatId: string;
  telegramUserId: string;
  createdAt: number;
  updatedAt: number;
  status: 'pending' | 'approved' | 'rejected';
}

/** Where an admitted contact request stands; see `RemoteContactStore.unfinished`. */
export type RemoteContactDisposition = 'pending' | 'running' | 'answered' | 'failed';

export interface RemoteContactThreadMessage {
  id: string;
  contactId: string;
  role: 'contact' | 'owner' | 'assistant';
  text: string;
  createdAt: number;
  /**
   * Inbound rows: `<channel>:<chatId>:<providerMessageId>`, so a redelivered
   * update is recognised rather than answered twice. Absent on assistant rows
   * and on rows written before it existed.
   */
  inboundKey?: string | undefined;
  /** Inbound rows: whether the request was answered. Survives a reload, unlike the burst timer. */
  disposition?: RemoteContactDisposition | undefined;
}

export type RemoteContactOutboundState =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'sent'
  | 'failed';

export interface RemoteContactOutboundRecord {
  id: string;
  contactId: string;
  ownerId: string;
  ownerChatId: string;
  recipientChatId: string;
  recipientDisplayName: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  state: RemoteContactOutboundState;
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
  /**
   * Transient status (e.g. a model unloaded): once delivered, the transport
   * deletes the message after `delete_command_replies_after`. Absent on records
   * written before this field existed — they keep their message.
   */
  ephemeral?: boolean | undefined;
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

export interface RemoteSelectionChoice {
  label: string;
  value: number;
}

export interface RemoteSelectionPages {
  send(
    chatId: string,
    text: string,
    controls: RemoteSelectionControls,
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<void>;
  /** Optional item picker used by transports with native choice buttons. */
  sendChoices?(
    chatId: string,
    text: string,
    choices: readonly RemoteSelectionChoice[],
    controls: RemoteSelectionControls,
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<void>;
  edit(
    chatId: string,
    messageId: string,
    text: string,
    controls: RemoteSelectionControls,
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<void>;
  close(chatId: string, messageId: string, options?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * Options for the status bubble's send and edits. `stopButton` attaches the
 * turn's Stop button; an edit without it removes the button, which is how the
 * terminal edit takes it away.
 */
export interface ProgressMessageOptions {
  signal?: AbortSignal;
  stopButton?: boolean;
}

export interface RemoteChannel {
  readonly name: RemoteInboundEvent['channel'];
  onEvent(handler: (event: RemoteInboundEvent) => Promise<RemoteInboundDisposition>): {
    dispose(): void;
  };
  /**
   * Resolves to the provider ids of the messages created (one per chunk) when
   * the transport knows them, so command-reply cleanup can delete them later.
   * Transports that cannot address a sent message resolve to nothing.
   */
  send(
    chatId: string,
    text: string,
    options?: { correlationId?: string; signal?: AbortSignal },
  ): Promise<string[] | void>;
  /** Optional typed inline keyboard used by Telegram contact approvals. */
  sendInlineKeyboard?(
    chatId: string,
    text: string,
    buttons: readonly RemoteContactButton[][],
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<string | undefined>;
  /** Telegram-only help message with a user-controlled close button. */
  sendHelp?(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<void>;
  /** Handles the close callback for a help message owned by this channel. */
  handleHelpAction(
    event: Extract<RemoteInboundEvent, { kind: 'help_action' }>,
  ): Promise<RemoteInboundDisposition>;
  answerCallbackQuery?(
    callbackId: string,
    text?: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  clearInlineKeyboard?(
    chatId: string,
    messageId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Telegram-only rich-text delivery. Other transports keep plain text. */
  sendHtml?(
    chatId: string,
    html: string,
    options?: { signal?: AbortSignal },
  ): Promise<string[] | void>;
  /** Best-effort presentation only; never an authoritative remote reply. */
  sendProgress?(
    chatId: string,
    text: string,
    options?: ProgressMessageOptions,
  ): Promise<string | undefined>;
  /**
   * Telegram-only rich-draft progress with Telegram's native Stop button.
   * Present only on transports that can stream a preview and finalize it; the
   * progress lifecycle falls back to `sendProgress` + `editMessage` without it.
   */
  richDraft?: RichDraftTransport;
  /** Best-effort presentation only; a reload may lose the provider message id. */
  editMessage?(
    chatId: string,
    messageId: string,
    text: string,
    options?: ProgressMessageOptions,
  ): Promise<void>;
  /**
   * Delete a previously sent message. Optional: channels with no such
   * affordance simply do not implement it, and command auto-cleanup is skipped.
   * Best-effort presentation only; a failure must never affect command
   * execution.
   */
  deleteMessage?(
    chatId: string,
    messageId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Registers cleanup for transport-sent queued acknowledgements and transient notices. */
  setEphemeralMessageHandler?(
    handler: ((chatId: string, messageIds: string[], kind: EphemeralKind) => void) | undefined,
  ): void;
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
  /** Deliver a local image file with a caption. Optional, like `sendVoice`. */
  sendPhoto?(
    chatId: string,
    filePath: string,
    caption: string,
    signal?: AbortSignal,
  ): Promise<void>;
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
  /**
   * Replace a resolved approval's buttons with one disabled button naming the
   * outcome, for every message that carried a keyboard for that correlation id.
   *
   * Telegram keeps an inline keyboard on a message until the message is edited,
   * so an Approve/Deny row that simply vanishes leaves no trace of the decision
   * the user just made. Optional: channels with no such affordance fall back to
   * `retractPrompt`. Rejects when a button could not be resolved — the caller
   * reports it, because a keyboard left pressable is worth a visible complaint.
   */
  resolvePromptKeyboard?(
    chatId: string,
    correlationId: string,
    keyboardMessageIds: readonly string[],
    approved: boolean,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
  requestPairingCode?(phoneNumber: string): Promise<string>;
  unlink?(): Promise<void>;
  healthCheck?(): Promise<RemoteTransportHealth>;
}

export interface RemoteContactButton {
  text: string;
  callbackData: string;
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
  /** Persist `remote.rate_limit_per_minute` and re-apply it live (`/ratelimit`). */
  setRateLimit?: ((perMinute: number) => Promise<void>) | undefined;
  reloadWindow?: (() => Promise<void>) | undefined;
  openWorkspace?: ((directory: string) => Promise<void>) | undefined;
  confirmWhisperServerStart?: ((detail: string) => Promise<boolean>) | undefined;
  /** Absolute path to `.forge/config.yaml`; enables the persisted /voice toggle. */
  configPath?: string | undefined;
  /**
   * The shared `JobStore` (B3), created once in extension.ts. Passed to the
   * controller-options builder so `/jobs` and `/job` can read and write the
   * same files the scheduler and the `manage_jobs` tool use.
   */
  jobStore?: import('../jobs/JobStore').JobStore | undefined;
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
