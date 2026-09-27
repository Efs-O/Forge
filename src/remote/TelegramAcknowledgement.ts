import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';

type TelegramTextOrVoiceEvent = Extract<RemoteInboundEvent, { kind: 'text' | 'voice' }>;
type SendTelegramText = (
  chatId: string,
  text: string,
  options?: { signal?: AbortSignal },
) => Promise<string[]>;
export type EphemeralAckHandler = (
  chatId: string,
  messageIds: string[],
  delaySeconds: number,
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
  onEphemeral?: EphemeralAckHandler,
): Promise<void> {
  if (event.chatType !== 'private') return;
  let text: string | undefined;
  /** Only the queued "got it" notice is transient; a rejection reason is kept. */
  let isQueuedAck = false;
  if (disposition.kind === 'queued') {
    isQueuedAck = true;
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
  if (isQueuedAck && messageIds.length > 0) {
    onEphemeral?.(event.chatId, messageIds, QUEUED_ACK_DELETE_SECONDS);
  }
}

export class TelegramAcknowledgement {
  private ephemeralHandler: EphemeralAckHandler | undefined;

  constructor(
    private readonly send: SendTelegramText,
    private readonly onError: ((message: string) => void) | undefined,
  ) {}

  setEphemeralHandler(handler: EphemeralAckHandler | undefined): void {
    this.ephemeralHandler = handler;
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
      (chatId, messageIds, delaySeconds) =>
        this.ephemeralHandler?.(chatId, messageIds, delaySeconds),
    );
  }
}
