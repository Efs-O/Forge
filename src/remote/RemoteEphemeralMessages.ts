import { QUEUED_ACK_DELETE_SECONDS } from './TelegramAcknowledgement';
import type { CommandCleanupScheduler } from './CommandCleanupScheduler';
import type { EphemeralKind, RemoteChannel, RemoteInboundDisposition } from './types';

export function ephemeralRejection(reason: string): RemoteInboundDisposition {
  return { kind: 'rejected', reason, ephemeral: true };
}

export function armRemoteEphemeralMessage(
  cleanup: CommandCleanupScheduler,
  chatId: string,
  messageIds: string[],
  kind: EphemeralKind,
): void {
  if (kind === 'queued') cleanup.armAfter(chatId, messageIds, QUEUED_ACK_DELETE_SECONDS);
  else cleanup.armEphemeral(chatId, messageIds);
}

export async function sendRemoteEphemeralMessage(
  channel: RemoteChannel,
  cleanup: CommandCleanupScheduler,
  chatId: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const messageIds = await channel.send(chatId, text, { signal });
  cleanup.armEphemeral(chatId, messageIds ?? []);
}
