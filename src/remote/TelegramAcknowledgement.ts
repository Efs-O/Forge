import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';

type TelegramTextOrVoiceEvent = Extract<RemoteInboundEvent, { kind: 'text' | 'voice' }>;
type SendTelegramText = (
  chatId: string,
  text: string,
  options?: { signal?: AbortSignal },
) => Promise<void>;

/** Sends the private-chat explanation for an inbound disposition, if needed. */
export async function acknowledgeTelegramDisposition(
  event: TelegramTextOrVoiceEvent,
  disposition: RemoteInboundDisposition,
  signal: AbortSignal,
  send: SendTelegramText,
  onError: ((message: string) => void) | undefined,
): Promise<void> {
  if (event.chatType !== 'private') return;
  let text: string | undefined;
  if (disposition.kind === 'queued') {
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
  await send(event.chatId, text, { signal }).catch((err) => {
    if (!signal.aborted) {
      onError?.(
        `Forge Telegram acknowledgement failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
