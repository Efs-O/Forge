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

/** `max` is the PER-SLOT window; a model with no resolvable num_ctx reports none. */
function describeBudget(budget: { used: number; max: number } | undefined): string {
  if (!budget || budget.max <= 0) return 'unavailable (no num_ctx for this model)';
  const percent = Math.round((budget.used / budget.max) * 100);
  return `${budget.used}/${budget.max} tokens (${percent}%)`;
}

async function executeRemoteCommand(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition> {
  const [command, argument] = event.text.trim().split(/\s+/, 2);
  if (command === '/help') {
    await context.channel.send(
      event.chatId,
      'Forge commands: /status, /stop, /new, /resume <conversation-id>, /compact, ' +
        '/clanker on|off. /stop cancels the current request; queued requests remain ' +
        'queued. /clanker on auto-approves non-dangerous tools until this window ' +
        'reloads — writes then land with no confirmation anywhere.',
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
      `Forge: ${status.requestChains.length} active request(s), ${queued} queued here, ${status.streamingConversationIds.length} streaming, ${requests.unknown} crash-unknown, ${outbox.pending} notifications pending, ${outbox.abandoned} abandoned.
` +
        `Context: ${describeBudget(binding && context.host.contextBudget(binding.conversationId))}
` +
        // Stated on every /status, not only when asked: a remote owner cannot
        // see the sidebar, and not knowing whether writes are gated is the one
        // thing they must never have to guess.
        `Approvals: ${context.host.clankerMode() ? 'CLANKER — non-dangerous tools auto-approved' : 'gated'}`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/clanker') {
    const desired = argument?.toLowerCase();
    if (desired !== 'on' && desired !== 'off') {
      return { kind: 'rejected', reason: 'usage: /clanker on|off' };
    }
    // Owner-authenticated command, never a tool: a model that could call this
    // would be able to switch off its own approval gate mid-turn.
    context.host.setClankerMode(desired === 'on');
    await context.channel.send(
      event.chatId,
      desired === 'on'
        ? 'Forge: clanker mode ON — non-dangerous tools now run with no approval, here or in the sidebar. It does not survive a window reload.'
        : 'Forge: clanker mode OFF — tool approvals are gated again.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/compact') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    const outcome = await context.host.compact(binding.conversationId);
    const budget = context.host.contextBudget(binding.conversationId);
    await context.channel.send(
      event.chatId,
      `Forge: compaction ${outcome}. Context: ${describeBudget(budget)}`,
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
