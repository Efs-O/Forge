import type * as vscode from 'vscode';
import type { ApprovalDecision } from '../sidebar/approvalMessages';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteInboundAttachment, RemoteInboundEvent } from './remoteInboundSchema';
import type { OutboxState } from './RemoteStoreSchemas';

/**
 * Which window a `/workspace <name>` switch gives up. `replace` reloads the
 * window that asked for the switch — what has always happened — and `new-window`
 * opens a second VS Code window beside it. Both stop this window's transports,
 * so the phone follows the switch either way; what differs is whether this
 * window survives it and whether a rollback has to say so.
 */
export type WorkspaceSwitchModeChoice = 'replace' | 'new-window';

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
  | { kind: 'handled'; afterHandled?: () => Promise<void> }
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
  /** A Telegram command addressed to an existing CLI session. */
  sessionTarget?: 'claude' | 'codex' | 'copilot' | undefined;
  /** Exact linked session captured when a remote agent ask starts. */
  senderSessionId?: string | undefined;
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

/**
 * The owner-approved contact records, kept in `remoteContactRecords.ts` and
 * re-exported here for the same reason the inbound contract above is: this
 * barrel is the one import site for the remote surface, and it had reached the
 * lint line limit again. No import site changed — the names come back the same.
 */
export {
  type RemoteContactRecord,
  type RemoteContactGroupLinkRecord,
  type RemoteContactPendingRecord,
  type RemoteContactDisposition,
  type RemoteContactThreadMessage,
  type RemoteContactOutboundState,
  type RemoteContactOutboundRecord,
} from './remoteContactRecords';

export interface RemoteOutboxRecord {
  id: string;
  requestId: string;
  channel: RemoteInboundEvent['channel'];
  chatId: string;
  text: string;
  state: OutboxState;
  attempts: number;
  updatedAt: number;
  /**
   * Transient status (e.g. a model unloaded): once delivered, the transport
   * deletes the message after `delete_command_replies_after`. Absent on records
   * written before this field existed — they keep their message.
   */
  ephemeral?: boolean | undefined;
  /** This turn's speed line; see `OutboxSchema`. It is never part of `text`. */
  speedLine?: string | undefined;
}

interface RemoteTransportHealth {
  ok: boolean;
  detail: string;
}

export interface RemoteSelectionControls {
  kind: 'models' | 'conversations' | 'workspaces';
  token: string;
  page: number;
  pageCount: number;
  /** Absolute, zero-based selection indices shown on this page. */
  pickIndexes?: readonly number[] | undefined;
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
 * Options for a progress message send or edit. `stopButton` attaches an inline
 * Stop control where the transport uses one; an edit without it removes that
 * button, which is how a terminal or retiring-bubble edit takes it away.
 */
export interface ProgressMessageOptions {
  signal?: AbortSignal;
  stopButton?: boolean;
  /**
   * False: a 429 throws `TelegramRateLimitError` instead of re-sending the
   * same body after `retry_after`. The live bubble sets it, because the body it
   * would re-send is an old snapshot; it waits and renders the latest instead.
   */
  retryRateLimit?: boolean;
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
    // `speedLine` is read only by Telegram, and only when it builds the last chunk.
    options?: {
      correlationId?: string;
      approvalAllowChat?: boolean;
      approvalAlwaysInProject?: boolean;
      signal?: AbortSignal;
      parseMode?: 'HTML';
      speedLine?: string;
    },
  ): Promise<string[] | void>;
  /** Set only by transports whose Bot API accepts Telegram HTML. */
  readonly parseMode?: 'HTML' | undefined;
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
    options?: {
      signal?: AbortSignal;
      parseMode?: 'HTML';
      buttons?: readonly RemoteContactButton[][];
    },
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
  /** Telegram-only in-place question keyboard update; other transports omit it. */
  replaceInlineKeyboard?(
    chatId: string,
    messageId: string,
    buttons: readonly RemoteContactButton[][],
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Retire the queued Telegram receipt for a request, if it had a button. */
  retireQueuedReceipt?(requestId: string): Promise<void>;
  /** Retire or clear the exact receipt that produced a callback, including after restart. */
  retireTappedQueuedReceipt?(requestId: string, chatId: string, messageId: string): Promise<void>;
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
  /** Telegram-only: a mirrored sidebar prompt, sent silently above the status. */
  sendProgressPrompt?(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  /** Remove the legacy 0.17.67 Telegram Stop key, independent of the auth lock. */
  removeProgressStopKeyboard?(chatId: string): Promise<void>;
  /** Best-effort presentation only; a reload may lose the provider message id. */
  editMessage?(
    chatId: string,
    messageId: string,
    text: string,
    options?: ProgressMessageOptions,
  ): Promise<void>;
  /** Telegram-only edit for a report/card that owns an inline keyboard. */
  editInlineKeyboardMessage?(
    chatId: string,
    messageId: string,
    text: string,
    buttons: readonly RemoteContactButton[][],
    options?: { signal?: AbortSignal; parseMode?: 'HTML' },
  ): Promise<void>;
  /** Telegram force-reply prompt; resolves to the provider message id. */
  sendForceReply?(
    chatId: string,
    text: string,
    placeholder: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
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
  /** Deliver a playable voice reply; channels without support skip speech. */
  sendVoice?(chatId: string, oggPath: string, signal?: AbortSignal): Promise<void>;
  /** Deliver a local image file with a caption. Optional, like `sendVoice`. */
  sendPhoto?(
    chatId: string,
    filePath: string,
    caption: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Stream to a caller-owned file so voice cleanup stays operation-scoped. */
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
   *
   * `decision` is the answer as the four choices every surface uses, so the
   * button a card keeps says which of them was clicked: `Allow for this chat`
   * wrote a rule, `Approve` did not, and a receipt that cannot tell them apart
   * tells the owner nothing about what will happen next time.
   */
  resolvePromptKeyboard?(
    chatId: string,
    correlationId: string,
    keyboardMessageIds: readonly string[],
    approved: boolean,
    options?: { signal?: AbortSignal },
    reason?: 'resolved' | 'cancelled' | 'timeout',
    decision?: ApprovalDecision,
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
  /** A VS Code Remote window: the desktop's own Forge window owns every transport, so this runtime starts none. The value is the reason a remote command shows. */
  hostedElsewhere?: string;
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
  openWorkspace?: ((directory: string, forceNewWindow: boolean) => Promise<void>) | undefined;
  /**
   * The window files' phone surface (`/workspace windows`, the Close button, and
   * the `new-window` cap check), built in `remoteRuntimeSetup.ts` from global
   * storage, the OS probe and the config. Passed through the controller options
   * to the command layer, which never touches the filesystem or PowerShell.
   */
  windowSurface?: import('./RemoteWindowRegistry').RemoteWindowSurface | undefined;
  /** Close this window from its own close-request watch (`workbench.action.closeWindow`). */
  closeWindow?: (() => Promise<void>) | undefined;
  /** True while this window has editors with unsaved changes, which is why a phone Close is refused rather than attempted — see `WorkspaceHandoffRuntimeDeps.hasUnsavedEditors`. */
  hasUnsavedEditors?: (() => boolean) | undefined;
  /**
   * The user-scope `forge.configFile`, read live. A workspace switch has to
   * know what the **target** window will load, and the target reads the same
   * user settings this window does unless it pins a config file of its own.
   */
  userConfigFileSetting?: (() => string | undefined) | undefined;
  confirmWhisperServerStart?: ((detail: string) => Promise<boolean>) | undefined;
  /** Absolute path to `.forge/config.yaml`; enables the persisted /voice toggle. */
  configPath?: string | undefined;
  /** Live BackendPool residency for window-level model status commands. */
  isModelLoaded?: ((modelName: string) => boolean) | undefined;
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
