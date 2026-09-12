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
    text =
      event.kind === 'text' && event.text.trim().toLowerCase().startsWith('/steer')
        ? `Forge: interrupting the turn; your steering prompt runs next (position ${disposition.position}).`
        : `Forge: queued at position ${disposition.position} — it runs when the current turn ends. Send /steer ${disposition.position} to cut the turn short and run it now, /queue to review, /drop ${disposition.position} to cancel.`;
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
