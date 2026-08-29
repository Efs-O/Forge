import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';

export interface RemoteCommandContext {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  host: ForgeHostFacade;
  workspaceId: string;
  signal: AbortSignal;
}

export async function handleRemoteCommand(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
  dedupKey: string,
): Promise<RemoteInboundDisposition> {
  const admission = await context.store.beginControlEvent(dedupKey);
  if (admission === 'completed') return { kind: 'handled' };
  if (admission === 'unknown') {
    return { kind: 'rejected', reason: 'previous command outcome is unknown; resend it' };
  }
  try {
    const result = await executeRemoteCommand(event, context);
    await context.store.finishControlEvent(dedupKey);
    return result;
  } catch (err) {
    await context.store.discardControlEvent(dedupKey);
    throw err;
  }
}

async function executeRemoteCommand(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition> {
  const [command, argument] = event.text.trim().split(/\s+/, 2);
  if (command === '/help') {
    await context.channel.send(
      event.chatId,
      'Forge commands: /status, /stop, /new, /resume <conversation-id>. /stop cancels the current request; queued requests remain queued.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/status') {
    const status = context.host.status();
    const binding = context.store.binding(event.channel, event.chatId);
    const queued = binding ? context.store.queued(binding.conversationId).length : 0;
    const requests = context.store.requestHealth();
    const outbox = context.store.outboxHealth();
    await context.channel.send(
      event.chatId,
      `Forge: ${status.requestChains.length} active request(s), ${queued} queued here, ${status.streamingConversationIds.length} streaming, ${requests.unknown} crash-unknown, ${outbox.pending} notifications pending, ${outbox.abandoned} abandoned.`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/stop') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    await context.host.cancel(binding.conversationId);
    await context.channel.send(
      event.chatId,
      'Forge: current request stopped; queued requests remain queued.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/new') {
    const conv = await context.host.createConversation({ activate: false });
    await context.store.setBinding({
      channel: event.channel,
      chatId: event.chatId,
      workspaceId: context.workspaceId,
      conversationId: conv.id,
    });
    await context.channel.send(event.chatId, `Forge: bound to new conversation ${conv.id}.`, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  if (command === '/resume' && argument) {
    const conv = await context.host.restoreConversation(argument, { activate: false });
    await context.store.setBinding({
      channel: event.channel,
      chatId: event.chatId,
      workspaceId: context.workspaceId,
      conversationId: conv.id,
    });
    await context.channel.send(event.chatId, `Forge: resumed conversation ${conv.id}.`, {
      signal: context.signal,
    });
    return { kind: 'handled' };
  }
  return { kind: 'rejected', reason: 'unknown command' };
}
