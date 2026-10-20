import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { describeError } from '../util/describeError';
import type { RemoteAuditLog } from './RemoteAuditLog';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { promoteQueuedInDraft } from './remoteQueueOrdering';
import { getLogger } from '../util/logger';

const log = getLogger();

type SendNowEvent = Extract<RemoteInboundEvent, { kind: 'send_now_action' }>;

export interface RemoteSendNowDeps {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  auth: RemoteAuth;
  host: ForgeHostFacade;
  audit?: RemoteAuditLog;
  isBusy: (conversationId: string) => boolean;
  kickDrain: (conversationId: string) => void;
  onError?: (message: string) => void;
}

const TOO_LATE = 'Too late — Forge already picked this up.';

export async function handleRemoteSendNow(
  event: SendNowEvent,
  deps: RemoteSendNowDeps,
): Promise<RemoteInboundDisposition> {
  const request = deps.store.getRequest(event.requestId);
  if (
    !request ||
    request.channel !== event.channel ||
    request.channel !== deps.channel.name ||
    request.chatId !== event.chatId ||
    request.state !== 'queued'
  ) {
    await rejectTap(event, deps, TOO_LATE);
    return { kind: 'rejected', reason: TOO_LATE };
  }

  const promoted = await deps.store.contactMutate((draft) =>
    promoteQueuedInDraft(draft.requests, request.conversationId, request.id),
  );
  if (!promoted) {
    await rejectTap(event, deps, TOO_LATE);
    return { kind: 'rejected', reason: TOO_LATE };
  }

  if (deps.isBusy(request.conversationId)) {
    deps.host.queueIntent(request.conversationId);
    try {
      await deps.host.interrupt(request.conversationId);
    } catch (err) {
      const message = `Forge remote Send now could not interrupt the turn: ${describeError(err)}`;
      if (deps.onError) deps.onError(message);
      else log.error(message);
    }
  }
  deps.kickDrain(request.conversationId);
  await retireReceipt(event, deps.channel, deps.onError);
  await deps.audit?.record(event, 'send_now', request.id);
  await answerCallback(event, deps.channel, 'Forge will run this next.');
  deps.auth.touch(event);
  return { kind: 'handled' };
}

async function rejectTap(
  event: SendNowEvent,
  deps: RemoteSendNowDeps,
  reason: string,
): Promise<void> {
  await retireReceipt(event, deps.channel, deps.onError);
  await answerCallback(event, deps.channel, reason);
}

async function retireReceipt(
  event: SendNowEvent,
  channel: RemoteChannel,
  onError?: (message: string) => void,
): Promise<void> {
  if (channel.retireTappedQueuedReceipt) {
    await channel.retireTappedQueuedReceipt(event.requestId, event.chatId, event.messageId);
    return;
  }
  await channel.retireQueuedReceipt?.(event.requestId);
  if (channel.deleteMessage) {
    try {
      await channel.deleteMessage(event.chatId, event.messageId);
      return;
    } catch (deleteError) {
      // Clearing the keyboard below is the required stale-button fallback.
      if (!channel.clearInlineKeyboard) {
        const message = `Could not delete or clear the queued receipt: ${describeError(deleteError)}`;
        if (onError) onError(message);
        else log.error(message);
        return;
      }
    }
  }
  if (!channel.clearInlineKeyboard) return;
  try {
    await channel.clearInlineKeyboard(event.chatId, event.messageId);
  } catch (err) {
    const message = `Could not clear the queued receipt keyboard: ${describeError(err)}`;
    if (onError) onError(message);
    else log.error(message);
  }
}

async function answerCallback(
  event: SendNowEvent,
  channel: RemoteChannel,
  text: string,
): Promise<void> {
  await channel.answerCallbackQuery?.(event.providerMessageId, text);
}
