import type { RemoteCommandContext } from './RemoteCommandHandler';
import type { RemoteInboundDisposition, RemoteInboundEvent } from './types';

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

/** Queue/session commands split from model, workspace, and lifecycle controls. */
export async function handleRemoteSessionCommand(
  command: string,
  argument: string | undefined,
  event: TextEvent,
  context: RemoteCommandContext,
): Promise<RemoteInboundDisposition | undefined> {
  if (command === '/help' || command === '/commands') {
    await context.channel.send(
      event.chatId,
      'Forge commands: /status, /context, /stop, /steer <prompt>, /new, /list, ' +
        '/resume <number-or-id>, /models, /model <number-or-name>, /queue, ' +
        '/drop <number|all>, /unload, /restart, /compact, /lock, ' +
        '/timeout [1-1440|off], /clanker on|off. /stop cancels the current request; queued requests remain ' +
        'queued. /steer interrupts the current turn and runs its prompt before ordinary queued prompts. ' +
        '/clanker on auto-approves non-dangerous tools until this window ' +
        'reloads — writes then land with no confirmation anywhere.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/status') {
    const status = context.host.status();
    const binding = context.store.binding(event.channel, event.chatId);
    const queued = binding ? ownQueue(event, context, binding.conversationId).length : 0;
    const requests = context.store.requestHealth();
    const outbox = context.store.outboxHealth();
    const conversation = status.conversations.find((item) => item.id === binding?.conversationId);
    await context.channel.send(
      event.chatId,
      `Chat: ${conversation ? `${conversation.title} · ${conversation.id}` : 'none bound'}\n` +
        `Model: ${conversation?.activeModel ?? 'default'}\n` +
        `Forge: ${status.requestChains.length} active request(s), ${queued} queued here, ${status.streamingConversationIds.length} streaming, ${requests.unknown} crash-unknown, ${outbox.pending} notifications pending, ${outbox.abandoned} abandoned.\n` +
        `Context: ${describeBudget(binding && context.host.contextBudget(binding.conversationId))}\n` +
        `Approvals: ${context.host.clankerMode() ? 'CLANKER — non-dangerous tools auto-approved' : 'gated'}`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/context') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    await context.channel.send(
      event.chatId,
      describeDetailedBudget(context.host.contextBudget(binding.conversationId)),
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
  if (command === '/queue') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    const queued = ownQueue(event, context, binding.conversationId);
    await context.channel.send(
      event.chatId,
      queued.length === 0
        ? 'Forge: no queued prompts for this chat.'
        : queued
            .map(
              (item, index) =>
                `${index + 1}. ${item.priority === 'steer' ? '[steer] ' : ''}${truncate(item.text, 160)}`,
            )
            .join('\n') + '\n\nUse /drop <number|all> to cancel queued work.',
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  if (command === '/drop') {
    const binding = context.store.binding(event.channel, event.chatId);
    if (!binding) return { kind: 'rejected', reason: 'no conversation is bound' };
    if (!argument) return { kind: 'rejected', reason: 'usage: /drop <number|all>' };
    const queued = ownQueue(event, context, binding.conversationId);
    if (queued.length === 0) return { kind: 'rejected', reason: 'no queued prompts to cancel' };
    let selected: ReadonlySet<string>;
    if (argument.toLowerCase() === 'all') {
      selected = new Set(queued.map((item) => item.id));
    } else {
      if (!/^\d+$/.test(argument)) {
        return { kind: 'rejected', reason: 'usage: /drop <number|all>' };
      }
      const item = queued[Number(argument) - 1];
      if (!item) return { kind: 'rejected', reason: 'queue number is out of range' };
      selected = new Set([item.id]);
    }
    const cancelled = await context.store.cancelQueued(binding.conversationId, selected);
    await context.channel.send(
      event.chatId,
      `Forge: cancelled ${cancelled} queued prompt${cancelled === 1 ? '' : 's'}.`,
      { signal: context.signal },
    );
    return { kind: 'handled' };
  }
  return undefined;
}

/** `max` is the per-slot window; a model with no resolvable num_ctx reports none. */
export function describeBudget(budget: { used: number; max: number } | undefined): string {
  if (!budget || budget.max <= 0) return 'unavailable (no num_ctx for this model)';
  const percent = Math.round((budget.used / budget.max) * 100);
  return `${budget.used}/${budget.max} tokens (${percent}%)`;
}

function describeDetailedBudget(budget: { used: number; max: number } | undefined): string {
  if (!budget || budget.max <= 0) return 'Forge context: unavailable (no num_ctx for this model).';
  const remaining = Math.max(0, budget.max - budget.used);
  const percent = Math.round((budget.used / budget.max) * 100);
  return (
    `Forge context: ${budget.used}/${budget.max} tokens (${percent}%).\n` +
    `Remaining: ${remaining} tokens. Auto-compaction uses the configured threshold and also runs after a recoverable context-exhaustion failure.`
  );
}

function ownQueue(event: TextEvent, context: RemoteCommandContext, conversationId: string) {
  return context.store
    .queued(conversationId)
    .filter((item) => item.channel === event.channel && item.chatId === event.chatId);
}

function truncate(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}
