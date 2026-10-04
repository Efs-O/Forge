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

/**
 * How long a "got it" queued acknowledgement stays in the chat before
 * auto-deleting. Fixed, not the config-driven `delete_command_replies_after`:
 * the transient queue notice should clear quickly, independent of how long
 * command replies linger.
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
): Promise<void> {
  if (event.chatType !== 'private') return;
  let text: string | undefined;
  if (disposition.kind === 'queued') {
    // Only a text event can be queued, so the attachment check stays guarded
    // even though the parameter now admits other kinds.
    const hasAttachments = event.kind === 'text' && (event.attachments?.length ?? 0) > 0;
    text = hasAttachments
      ? `Forge: got it — attachments wait, so this runs when the current turn ends. /drop ${disposition.position} to cancel.`
      : `Forge: got it — Forge reads this after its current step. /drop ${disposition.position} to cancel.`;
  } else if (disposition.kind === 'rejected') {
    text = disposition.reason.startsWith('Forge:')
      ? disposition.reason
      : `Forge: ${disposition.reason}`;
  }
  if (!text) return;
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
    );
  }
}
