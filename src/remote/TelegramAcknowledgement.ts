import type { EphemeralKind, RemoteInboundDisposition, RemoteInboundEvent } from './types';

/**
 * Which inbound kinds get a disposition notice.
 *
 * `unsupported_media` belongs here: a rejection computed for it would otherwise
 * be discarded by the transport and the sender would still see nothing, which
 * is the exact silence Phase 3 exists to remove. `queued` never happens for it
 * (it admits no prompt), so only the rejection arm of the function can fire.
 */
type TelegramNoticeEvent = Extract<
  RemoteInboundEvent,
  { kind: 'text' | 'voice' | 'unsupported_media' }
>;
type TelegramTextOrVoiceEvent = TelegramNoticeEvent;
type SendTelegramText = (
  chatId: string,
  text: string,
  options?: { signal?: AbortSignal },
) => Promise<string[]>;
export type EphemeralMessageHandler = (
  chatId: string,
  messageIds: string[],
  kind: EphemeralKind,
) => void;
export type SendQueuedReceipt = (
  chatId: string,
  text: string,
  requestId: string,
  signal: AbortSignal,
) => Promise<string | undefined>;

/**
 * How long a text-only fallback "got it" receipt stays in the chat before
 * auto-deleting. Button receipts live until their queued request is claimed.
 * Fixed, not the config-driven command-reply delay.
 */
export const QUEUED_ACK_DELETE_SECONDS = 10;

/** Sends the private-chat explanation for an inbound disposition, if needed. */
export async function acknowledgeTelegramDisposition(
  event: TelegramTextOrVoiceEvent,
  disposition: RemoteInboundDisposition,
  signal: AbortSignal,
  send: SendTelegramText,
  onError: ((message: string) => void) | undefined,
  onEphemeral?: EphemeralMessageHandler,
  sendQueuedReceipt?: SendQueuedReceipt,
): Promise<void> {
  if (event.chatType !== 'private') return;
  let text: string | undefined;
  if (disposition.kind === 'queued') {
    // Only a text event can be queued, so the attachment check stays guarded
    // even though the parameter now admits other kinds.
    const hasAttachments = event.kind === 'text' && (event.attachments?.length ?? 0) > 0;
    text = hasAttachments
      ? `Forge: got it — attachments wait for the turn to end. Send now ends it early. /drop ${disposition.position} to cancel.`
      : `Forge: got it — Forge reads this after its current step. Send now stops the turn and runs it next. /drop ${disposition.position} to cancel.`;
  } else if (disposition.kind === 'rejected') {
    text = disposition.reason.startsWith('Forge:')
      ? disposition.reason
      : `Forge: ${disposition.reason}`;
  }
  if (!text) return;
  if (disposition.kind === 'queued' && sendQueuedReceipt) {
    try {
      const messageId = await sendQueuedReceipt(event.chatId, text, disposition.requestId, signal);
      if (messageId) return;
    } catch (err) {
      if (!signal.aborted) {
        onError?.(
          `Forge Telegram Send now receipt failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  const messageIds = await send(event.chatId, text, { signal }).catch((err) => {
    if (!signal.aborted) {
      onError?.(
        `Forge Telegram acknowledgement failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return [];
  });
  if (messageIds.length > 0) {
    if (disposition.kind === 'queued') onEphemeral?.(event.chatId, messageIds, 'queued');
    else if (disposition.kind === 'rejected' && disposition.ephemeral) {
      onEphemeral?.(event.chatId, messageIds, 'transient');
    }
  }
}

export class TelegramAcknowledgement {
  private ephemeralHandler: EphemeralMessageHandler | undefined;

  constructor(
    private readonly send: SendTelegramText,
    private readonly onError: ((message: string) => void) | undefined,
    private readonly sendQueuedReceipt?: SendQueuedReceipt,
  ) {}

  setEphemeralHandler(handler: EphemeralMessageHandler | undefined): void {
    this.ephemeralHandler = handler;
  }

  notifyEphemeral(chatId: string, messageIds: string[], kind: EphemeralKind): void {
    this.ephemeralHandler?.(chatId, messageIds, kind);
  }

  acknowledge(
    event: TelegramTextOrVoiceEvent,
    disposition: RemoteInboundDisposition,
    signal: AbortSignal,
  ): Promise<void> {
    return acknowledgeTelegramDisposition(
      event,
      disposition,
      signal,
      this.send,
      this.onError,
      (chatId, messageIds, kind) => this.notifyEphemeral(chatId, messageIds, kind),
      this.sendQueuedReceipt,
    );
  }
}
