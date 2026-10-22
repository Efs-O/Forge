import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { describeError } from '../util/describeError';
import { getLogger } from '../util/logger';
import type { RemoteAgentProgress } from './RemoteAgentProgress';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteRequestStore } from './RemoteRequestStore';
import { removeProgressStopControl } from './remoteProgressOpen';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';

const log = getLogger();

export interface RemoteStopActionDeps {
  channel: RemoteChannel;
  progress: RemoteAgentProgress;
  store: RemoteRequestStore;
  auth: RemoteAuth;
  host: ForgeHostFacade;
  onError?: (message: string) => void;
}

/** Resolves inline callbacks by message and reply-keyboard taps by bound chat. */
export async function handleRemoteStopAction(
  event: Extract<RemoteInboundEvent, { kind: 'stop_action' }>,
  deps: RemoteStopActionDeps,
): Promise<RemoteInboundDisposition> {
  const keyboard = event.source === 'keyboard';
  const boundConversation = keyboard
    ? deps.store.binding(event.channel, event.chatId)?.conversationId
    : undefined;
  const liveConversation = keyboard
    ? deps.progress.conversationForChat(event.chatId)
    : event.messageId
      ? deps.progress.conversationForBubble(event.chatId, event.messageId)
      : undefined;
  const conversationId =
    keyboard && boundConversation !== liveConversation ? undefined : liveConversation;
  const pressed = keyboard ? 'reply keyboard' : `bubble ${event.messageId ?? 'unknown'}`;

  log.info(
    `[remote:${event.channel}] Stop on ${pressed}: ` +
      (conversationId ? `cancelling ${conversationId}` : 'no live turn, ignored'),
  );
  if (!conversationId) return rejectOrHealStaleStop(event, deps, keyboard);

  try {
    await deps.host.cancel(conversationId);
  } catch (err) {
    deps.onError?.(`Forge remote Stop could not cancel the turn: ${describeError(err)}`);
  }
  deps.auth.touch(event);
  return { kind: 'handled' };
}

async function rejectOrHealStaleStop(
  event: Extract<RemoteInboundEvent, { kind: 'stop_action' }>,
  deps: RemoteStopActionDeps,
  keyboard: boolean,
): Promise<RemoteInboundDisposition> {
  if (keyboard) {
    try {
      await deps.channel.send(event.chatId, 'Forge: nothing is running.');
    } catch (err) {
      deps.onError?.(`Forge stale Stop reply failed: ${describeError(err)}`);
    }
    try {
      await deps.channel.removeProgressStopKeyboard?.(event.chatId);
    } catch (err) {
      deps.onError?.(`Forge stale Stop keyboard cleanup failed: ${describeError(err)}`);
    }
    return { kind: 'handled' };
  }
  if (event.source === 'control' || event.control) {
    try {
      if (event.messageId) {
        await removeProgressStopControl(deps.channel, event.chatId, event.messageId);
      }
    } catch (err) {
      deps.onError?.(`Forge stale Stop control cleanup failed: ${describeError(err)}`);
    }
  }
  return { kind: 'rejected', reason: 'This turn has already ended.' };
}
